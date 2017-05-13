'use strict'
const RippleAPI = require('ripple-lib').RippleAPI
const keypairs = require('ripple-keypairs')
const co = require('co')
const debug = require('debug')('ilp-plugin-xrp-escrow')
const EventEmitter2 = require('eventemitter2')
const BigNumber = require('bignumber.js')
const assert = require('assert')
const crypto = require('crypto')

const HttpRpc = require('./rpc')
const Translate = require('./translate')
const Condition = require('./condition')
const Errors = require('./errors')
const Submitter = require('./submitter')

module.exports = class PluginXrpEscrow extends EventEmitter2 {
  constructor (opts) {
    super()

    this._server = opts.server
    this._secret = opts.secret
    this._connected = false
    this._prefix = 'g.crypto.ripple.escrow.'

    this._transfers = {}
    this._notesToSelf = {}
    this._fulfillments = {}
    this._rpcUris = opts.rpcUris || {}

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

  // used when peer has enabled rpc
  async _handleSendMessage (message) {
    // TODO: validate message
    this.emitAsync('incoming_message', message)
    return true
  }

  async connect () {
    debug('connecting to api')
    await this._api.connect()
    debug('subscribing to account notifications for', this._address)
    await this._api.connection.request({
      command: 'subscribe',
      accounts: [ this._address ]
    })

    this._api.connection.on('transaction', (ev) => {
      console.log('\x1b[31mNOTIFY:\x1b[39m', ev)
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

  async sendTransfer (transfer) {
    assert(this._connected, 'plugin must be connected before sendTransfer')
    debug('preparing to create escrowed transfer')
    
    const [ , localAddress ] = transfer.to.match(/^g\.crypto\.ripple\.escrow\.(.+)/)
    const dropAmount = (new BigNumber(transfer.amount)).shift(-6)

    // TODO: is there a better way to do note to self?
    this._notesToSelf[transfer.id] = JSON.parse(JSON.stringify(transfer.noteToSelf))

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

    await Submitter.submit(this._api, signed)
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

    await Submitter.submit(this._api, signed)
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

      await Submitter.submit(this._api, signed)
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

    const [ , localAddress ] = message.to.match(/^g\.crypto\.ripple\.escrow\.(.+)/)
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
      }]
    })

    const signed = await this._api.sign(tx.txJSON, this._secret)
    debug('signing and submitting message tx: ' + tx.txJSON)
    debug('message tx is', signed.id)

    await Submitter.submit(this._api, signed)
    debug('completed message tx')
  }

  _handleTransaction (ev) {
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
      this.emitAsync(message.direction + '_message', message)
    }
  }
}
