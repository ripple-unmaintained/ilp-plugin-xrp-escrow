'use strict'
const RippleAPI = require('ripple-lib').RippleAPI
const keypairs = require('ripple-keypairs')
const co = require('co')
const debug = require('debug')('ilp-plugin-xrp-escrow')
const EventEmitter2 = require('eventemitter2')
const BigNumber = require('bignumber.js')
const assert = require('assert')
const crypto = require('crypto')
const defaultMessageTimeout = 5000

const HttpRpc = require('./rpc')
const Translate = require('./translate')
const Condition = require('./condition')
const Errors = require('./errors')

module.exports = class PluginXrpEscrow extends EventEmitter2 {
  constructor (opts) {
    super()

    this._server = opts.server
    this._secret = opts.secret
    this._connected = false
    this._prefix = opts.prefix || 'g.crypto.ripple.escrow.'

    this._transfers = {}
    this._submitted = {}
    this._notesToSelf = {}
    this._fulfillments = {}
    this._pendingRequests = {}
    this._rpcUris = opts.rpcUris || {}

    this.transferQueue = Promise.resolve()

    if (!this._secret) {
      throw new Errors.InvalidFieldsError('missing opts.secret')
    }

    const keys = keypairs.deriveKeypair(this._secret)
    const address = keypairs.deriveAddress(keys.publicKey)
    this._address = opts.address || address

    if (address !== this._address) {
      throw new Errors.InvalidFieldsError(
        'opts.address does not correspond to opts.secret.' +
        ' address=' + address +
        ' opts=' + JSON.stringify(opts))
    }

    if (!this._server) {
      throw new Errors.InvalidFieldsError('missing opts.server')
    }

    this._api = new RippleAPI({ server: this._server })

    // set up RPC if peer has your RPC uri
    this._rpc = new HttpRpc(this)
    this._rpc.addMethod('send_message', this._handleSendMessage)
    this.isAuthorized = () => true
    this.receive = co.wrap(this._rpc._receive).bind(this._rpc)
  }

  async sendRequest (message) {
    const requestId = message.id || uuid()
    const responded = new Promise((resolve, reject) => {
      this._pendingRequests[requestId] = {resolve, reject}
      this.sendMessage(Object.assign({id: requestId}, message)).catch((err) => {
        delete this._pendingRequests[requestId]
        reject(err)
      })
    })

    await this.emitAsync('outgoing_request', message)
    return await Promise.race([
      responded,
      wait(message.timeout || defaultMessageTimeout)
        .then(() => {
          delete this._pendingRequests[requestId]
          throw new Error('sendRequest timed out')
        })
    ])
  }

  async registerRequestHandler (handler) {
    this._requestHandler = handler
  }

  async _handleSendMessage (message) {
    const messageId = message.id
    const pendingRequest = this._pendingRequests[messageId]
    // `message` is a ResponseMessage
    if (pendingRequest) {
      delete this._pendingRequests[messageId]
      await this.emitAsync('incoming_response', message)
      pendingRequest.resolve(message)
      return
    }
    // `message` is a RequestMessage
    await this.emitAsync('incoming_request', message)
    if (!this._requestHandler) return
    const responseMessage = await this._requestHandler(message).then((responseMessage) => {
      if (!responseMessage) {
        throw new Error('No matching handler for request')
      }
      return responseMessage
    }).catch((err) => {
      return {
        ledger: message.ledger,
        from: message.to,
        to: message.from,
        ilp: IlpPacket.serializeIlpError({
          code: 'F00',
          name: 'Bad Request',
          triggeredBy: this.getAccount(),
          forwardedBy: [],
          triggeredAt: new Date(),
          data: JSON.stringify({message: err.message})
        }).toString('base64')
      }
    })
    await this.emitAsync('outgoing_response', responseMessage)
    return await this._sendMessage(Object.assign({id: messageId}, responseMessage))
  }

  async connect () {
    if (this._connected) return

    debug('connecting to api')
    await this._api.connect()
    debug('subscribing to account notifications for', this._address)
    await this._api.connection.request({
      command: 'subscribe',
      accounts: [ this._address ]
    })

    this._api.connection.on('transaction', (ev) => {
      if (!ev.validated) return
      if (ev.engine_result !== 'tesSUCCESS') return

      this._handleTransaction(ev)
    })

    debug('connected')
    this._connected = true
    this.emitAsync('connect')
  }

  async disconnect () {
    debug('disconnecting from api')
    await this._api.disconnect()
    debug('disconnected')
    this._connected = false
  }

  isConnected () {
    return this._connected
  }

  getAccount () {
    return this._prefix + this._address
  }

  getInfo () {
    return {
      prefix: this._prefix,
      currencyScale: 6,
      currencyCode: 'XRP'
    }
  }

  async getBalance () {
    assert(this._connected, 'plugin must be connected before getBalance')
    debug('requesting account info for balance')

    const info = await this._api.getAccountInfo(this._address)
    const dropBalance = (new BigNumber(info.xrpBalance)).shift(6)
    return dropBalance.round().toString()
  }

  async getFulfillment (transferId) {
    assert(this._connected, 'plugin must be connected before getFulfillment')
    debug('fetching fulfillment of', transferId)

    const transfer = this._transfers[transferId]
    const fulfillment = this._fulfillments[transferId]

    if (!fulfillment && !transfer) {
      throw new Errors.TransferNotFoundError('no transfer with id ' +
        transferId + ' found')
    } else if (!fulfillment && transfer.Done) {
      throw new Errors.AlreadyRolledBackError(transferId +
        ' has already been cancelled')
    } else if (!fulfillment) {
      throw new Errors.MissingFulfillmentError(transferId +
        ' has neither been fulfilled nor cancelled yet')
    }

    return fulfillment
  }

  sendTransfer (transfer) {
    this.transferQueue = this.transferQueue.then(() => {
      return this.doSendTransfer(transfer)
    })
    return this.transferQueue
  }

  async doSendTransfer (transfer) {
    assert(this._connected, 'plugin must be connected before sendTransfer')
    debug('preparing to create escrowed transfer')
    if (typeof transfer.to !== 'string' || !transfer.to.startsWith(this._prefix)) {
      throw new Error('transfer.to "' + transfer.to + '" does not start with ' + this._prefix)
    }

    const localAddress = transfer.to.substring(this._prefix.length)
    const dropAmount = (new BigNumber(transfer.amount)).shift(-6)

    // TODO: is there a better way to do note to self?
    this._notesToSelf[transfer.id] = JSON.parse(JSON.stringify(transfer.noteToSelf || {}))

    debug('sending', dropAmount.toString(), 'to', localAddress,
      'condition', transfer.executionCondition)

    const tx = await this._api.prepareEscrowCreation(this._address, {
      amount: dropAmount.toString(),
      destination: localAddress.split('.')[0],
      allowCancelAfter: transfer.expiresAt,
      condition: Condition.conditionToRipple(transfer.executionCondition),
      memos: [{
        type: 'https://interledger.org/rel/xrpIlp',
        data: transfer.ilp
      }, {
        type: 'https://interledger.org/rel/xrpId',
        data: transfer.id
      }]
    })

    const signed = this._api.sign(tx.txJSON, this._secret)
    debug('signing and submitting transaction: ' + tx.txJSON)
    debug('transaction id of', transfer.id, 'is', signed.id)

    await this._submit(signed)
    debug('completed transaction')

    debug('setting up expiry')
    this._setupExpiry(transfer.id, transfer.expiresAt)
  }

  async fulfillCondition (transferId, fulfillment) {
    assert(this._connected, 'plugin must be connected before fulfillCondition')
    debug('preparing to fulfill condition', transferId)

    const cached = this._transfers[transferId]
    if (!cached) {
      throw new Error('no transfer with id ' + transferId)
    }

    const condition = crypto
      .createHash('sha256')
      .update(Buffer.from(fulfillment, 'base64'))
      .digest()
      .toString('base64')

    const tx = await this._api.prepareEscrowExecution(this._address, {
      owner: cached.Account,
      escrowSequence: cached.Sequence,
      condition: Condition.conditionToRipple(condition),
      fulfillment: Condition.fulfillmentToRipple(fulfillment)
    })

    const signed = this._api.sign(tx.txJSON, this._secret)
    debug('signing and submitting transaction: ' + tx.txJSON)
    debug('fulfill tx id of', transferId, 'is', signed.id)

    await this._submit(signed)
    debug('completed fulfill transaction')
  }

  _setupExpiry (transferId, expiresAt) {
    const that = this
    // TODO: this is a bit of an unsafe hack, but if the time is not adjusted
    // like this, the cancel transaction fails.
    const delay = (new Date(expiresAt)) - (new Date()) + 5000

    setTimeout(
      that._expireTransfer.bind(that, transferId),
      delay)
  }

  async _expireTransfer (transferId) {
    if (this._transfers[transferId].Done) return
    debug('preparing to cancel transfer at', new Date().toISOString())

    // make sure that the promise rejection is handled no matter
    // which step it happens during.
    try {
      const cached = this._transfers[transferId]
      const tx = await this._api.prepareEscrowCancellation(this._address, {
        owner: cached.Account,
        escrowSequence: cached.Sequence
      })

      const signed = this._api.sign(tx.txJSON, this._secret)
      debug('signing and submitting transaction: ' + tx.txJSON)
      debug('cancel tx id of', transferId, 'is', signed.id)

      await this._submit(signed)
      debug('completed cancel transaction')
    } catch (e) {
      debug('CANCELLATION FAILURE! error was:', e.message)

      // just retry if it was a ledger thing
      // TODO: is there any other scenario to retry under?
      if (e.name !== 'NotAcceptedError') return

      debug('CANCELLATION FAILURE! (' + transferId + ') retrying...')
      await this._expireTransfer(transferId)
    }
  }

  async rejectIncomingTransfer (transferId) {
    if (this._transfers[transferId].Done) return
    debug('pretending to reject incoming transfer', transferId)

    const that = this
    return await new Promise((resolve) => {
      function done (transfer) {
        if (transfer.id !== transferId) return
        that.removeListener('incoming_cancel', done)
        that.removeListener('outgoing_cancel', done)
        resolve()
      }

      that.on('incoming_cancel', done)
      that.on('outgoing_cancel', done)
    })
  }

  async sendMessage (_message) {
    assert(this._connected, 'plugin must be connected before sendMessage')

    if (this._rpcUris[_message.to]) {
      this._rpc.call(
        this._rpcUris[_message.to],
        'send_message',
        this._prefix,
        [_message])

      this.emitAsync('outgoing_message', _message)
      return
    }

    const message = Object.assign({}, _message)
    debug('preparing to send message:', message)
    if (message.account) {
      message.to = message.account
    }

    if (typeof message.to !== 'string' || !message.to.startsWith(this._prefix)) {
      throw new Error('message.to "' + message.to + '" does not start with ' + this._prefix)
    }

    const localAddress = message.to.substring(this._prefix.length)
    const tx = await this._api.preparePayment(this._address, {
      source: {
        address: this._address,
        maxAmount: {
          value: '0.000001',
          currency: 'XRP'
        }
      },
      destination: {
        address: localAddress.split('.')[0],
        amount: {
          value: '0.000001',
          currency: 'XRP'
        }
      },
      memos: [{
        type: 'https://interledger.org/rel/xrpMessage',
        data: JSON.stringify(message.data)
      }, {
        type: 'https://interledger.org/rel/xrpMessageId',
        data: message.id || uuid()
      }]
    })

    const signed = await this._api.sign(tx.txJSON, this._secret)
    debug('signing and submitting message tx: ' + tx.txJSON)
    debug('message tx is', signed.id)

    await this._submit(signed)
    debug('completed message tx')
  }

  async _submit (signed) {
    const txHash = signed.id
    const result = new Promise((resolve, reject) => {
      this._submitted[txHash] = { resolve, reject }
    })

    await this._api.submit(signed.signedTransaction)
    debug('submitted transaction', txHash)

    await result
  }

  _handleTransaction (ev) {
    // handle submit result:
    if (ev.validated && ev.transaction && this._submitted[ev.transaction.hash]) {
      // give detailed error on failure
      if (ev.engine_result !== 'tesSUCCESS') {
        this._submitted[ev.transaction.hash].reject(new Errors.NotAcceptedError('transaction with hash "' +
          ev.transaction.hash + '" failed with engine result: ' +
          JSON.stringify(ev)))
      } else {
        // no info returned on success
        this._submitted[ev.transaction.hash].resolve(null)
      }
    }

    debug('got a notification of a transaction')
    const transaction = ev.transaction

    if (transaction.TransactionType === 'EscrowCreate') {
      const transfer = Translate.escrowCreateToTransfer(this, ev)
      this.emitAsync(transfer.direction + '_prepare', transfer)
    } else if (transaction.TransactionType === 'EscrowFinish') {
      const transfer = Translate.escrowFinishToTransfer(this, ev)
      // TODO: clear the cache at some point
      const fulfillment = Condition.rippleToFulfillment(transaction.Fulfillment)
      this.emitAsync(transfer.direction + '_fulfill', transfer, fulfillment)

      // remove note to self from the note to self cache
      delete this._notesToSelf[transfer.id]
      this._fulfillments[transfer.id] = fulfillment
      this._transfers[transfer.id].Done = true
    } else if (transaction.TransactionType === 'EscrowCancel') {
      // TODO: clear the cache at some point
      const transfer = Translate.escrowCancelToTransfer(this, ev)
      this.emitAsync(transfer.direction + '_cancel', transfer)

      // remove note to self from the note to self cache
      delete this._notesToSelf[transfer.id]
      this._transfers[transfer.id].Done = true
    } else if (transaction.TransactionType === 'Payment') {
      const message = Translate.paymentToMessage(this, ev)
      this._handleSendMessage(message)
      this.emitAsync(message.direction + '_message', message)
    }
  }
}
