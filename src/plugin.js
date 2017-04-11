'use strict'
const RippleAPI = require('ripple-lib').RippleAPI
const keypairs = require('ripple-keypairs')
const co = require('co')
const debug = require('debug')('ilp-plugin-xrp-escrow')
const EventEmitter2 = require('eventemitter2')
const BigNumber = require('bignumber.js')
const assert = require('assert')

module.exports = class PluginXrpEscrow extends EventEmitter2 {
  constructor (opts) {
    super()

    this._server = opts.server
    this._secret = opts.secret
    this._connected = false
    this._prefix = 'g.crypto.ripple.'
    this._transfers = {}

    const keys = keypairs.deriveKeypair(this._secret)
    const address = keypairs.deriveAddress(keys.publicKey)
    this._address = opts.address || address

    if (address !== this._address) {
      throw new Error('opts.address does not correspond to opts.secret.' +
        ' address=' + address +
        ' opts=' + JSON.stringify(opts))
    }

    this._api = new RippleAPI({ server: this._server })
    
    // define wrapped asynchronous methods
    this.connect = co.wrap(this._connect).bind(this)
    this.disconnect = co.wrap(this._disconnect).bind(this)
    this.getBalance = co.wrap(this._getBalance).bind(this)
    this.sendTransfer = co.wrap(this._sendTransfer).bind(this)
    this.fulfillCondition = co.wrap(this._fulfillCondition).bind(this)
    this.sendMessage = co.wrap(this._sendMessage).bind(this)
  }

  * _connect () {
    debug('connecting to api')
    yield this._api.connect()
    debug('subscribing to account notifications for', this._address)
    yield this._api.connection.request({
      command: 'subscribe',
      accounts: [ this._address ]
    })

    /*
    const conn = this._api.connection
    const oldemit = this._api.connection.emit
    const newemit = function () {
      console.log('\x1b[31mNOTIFY:\x1b[39m', arguments)
      oldemit.call(conn, ...arguments)
    }
    */

    // this._api.connection.emit = newemit

    this._api.connection.on('transaction', (ev) => {
      //console.log('\x1b[31mNOTIFY:\x1b[39m', ev)
      if (ev.engine_result !== 'tesSUCCESS') return
      if (!ev.validated) return

      this._handleTransaction(ev.transaction)
    })

    debug('connected')
    this._connected = true
    this.emitAsync('connect')
  }

  * _disconnect () {
    debug('disconnecting from api')
    yield this._api.disconnect()
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

  * _getBalance () {
    assert(this._connected, 'plugin must be connected before getBalance')
    debug('requesting account info for balance')

    const info = yield this._api.getAccountInfo(this._address)
    const dropBalance = (new BigNumber(info.xrpBalance)).shift(6)
    return dropBalance.round().toString()
  }

  * _sendTransfer (transfer) {
    assert(this._connected, 'plugin must be connected before sendTransfer')
    debug('preparing to create escrowed transfer')
    
    const [ , localAddress ] = transfer.to.match(/^g\.crypto\.ripple\.(.+)/)
    const dropAmount = (new BigNumber(transfer.amount)).shift(-6)
    const hexCondition = Buffer
      .from(transfer.executionCondition, 'base64')
      .toString('hex')

    debug('sending', dropAmount.toString(), 'to', localAddress)
    debug('condition', hexCondition.toUpperCase())

    const tx = yield this._api.prepareEscrowCreation(this._address, {
      amount: dropAmount.toString(),
      destination: localAddress.split('.')[0],
      allowCancelAfter: transfer.expiresAt,
      //condition: hexCondition.toUpperCase(),
      condition: 'A0258020E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855810100',
      memos: [{
        type: 'https://interledger.org/rel/xrpTransfer',
        data: transfer.ilp
      }, {
        type: 'https://interledger.org/rel/xrpId',
        data: transfer.id
      }]
    })

    const signed = this._api.sign(tx.txJSON, this._secret)
    debug('signing and submitting transaction: ' + tx.txJSON)
    debug('transaction id of', transfer.id, 'is', signed.id)

    // cache information for fulfill time
    this._transfers[transfer.id] = {
      id: signed.id,
      owner: this._account,
      sequence: JSON.parse(tx.txJSON).Sequence
    }

    yield this._api.submit(signed.signedTransaction)
    debug('submitted transaction')
  }

  * _fulfillCondition (transferId, fulfillment) {
    assert(this._connected, 'plugin must be connected before fulfillCondition')
    debug('preparing to fulfill condition')

    const cached = this._transfers[transferId]
    const tx = yield this._api.prepareEscrowExecution(this._address, {
      owner: cached.owner,
      escrowSequence: cached.sequence,
      condition: 'A0258020E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855810100',
      fulfillment: 'A0028000'
    })
    
    const signed = this._api.sign(tx.txJSON, this._secret)
    debug('signing and submitting transaction: ' + tx.txJSON)
    debug('fulfill tx id of', transferId, 'is', signed.id)

    yield this._api.submit(signed.signedTransaction)
    debug('submitted fulfill transaction')
  }

  * _sendMessage (message) {
    assert(this._connected, 'plugin must be connected before sendMessage')
    debug('preparing to send message')

    const [ , localAddress ] = message.to.match(/^g\.crypto\.ripple\.(.+)/)
    const tx = yield this._api.preparePayment(this._address, {
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

    const signed = yield this._api.sign(tx.txJSON, this._secret)
    debug('signing and submitting message tx: ' + tx.txJSON)
    debug('message tx is', signed.id)

    yield this._api.submit(signed.signedTransaction)
    debug('submitted message tx')
  }

  _handleTransaction (transaction) {
    debug('got a notification of a transaction')

    let direction = 'incoming'
    if (transaction.Account === this._address) direction = 'outgoing'

    const memos = {}
    for (const m of (transaction.Memos || [])) {
      const type = Buffer.from(m.Memo.MemoType, 'hex').toString('utf8')
      //console.log(type)
      memos[type] = Buffer.from(m.Memo.MemoData, 'hex')
    }

    const messageData = memos['https://interledger.org/rel/xrpMessage']
    if (messageData) {
      debug('got', direction, 'message with data', messageData.toString('utf8'))
      this.emitAsync(direction + '_message',
        JSON.parse(messageData.toString('utf8')))
    }

    if (transaction.TransactionType === 'EscrowCreate') {
      const id = memos['https://interledger.org/rel/xrpId'].toString('utf8')
      const ilp = memos['https://interledger.org/rel/xrpTransfer'].toString('utf8')

      this._transfers[id] = {
        id: id,
        ilp: ilp,
        hash: transaction.hash,
        owner: transaction.Account,
        sequence: transaction.Sequence
      }
      this._transfers[transaction.Account + ':' + transaction.Sequence] = this._transfers[id]

      this.emitAsync(direction + '_prepare', {
        id: id,
        to: this._prefix + transaction.Destination,
        from: this._prefix + transaction.Account,
        ledger: this._prefix,
        amount: transaction.Amount,
        ilp: ilp,
        executionCondition: transaction.Condition,
        // TODO: this needs to be more exact
        expiresAt: (new Date()).toISOString()
      })
    }

    if (transaction.TransactionType === 'EscrowFinish') {
      const cached = this._transfers[transaction.Owner + ':' + transaction.OfferSequence]

      this._api.getTransaction(cached.hash)
        .then((tx) => {
          if (tx.address === this._address) direction = 'outgoing'
          if (tx.specification.destination === this._address) direction = 'incoming'

          return this.emitAsync(direction + '_fulfill', {
            id: cached.id,
            to: this._prefix + tx.specification.destination,
            from: this._prefix + tx.address,
            ledger: this._prefix,
            amount: (new BigNumber(tx.specification.amount)).shift(6).round().toString(),
            ilp: cached.ilp,
            executionCondition: tx.specification.condition,
            // TODO: this needs to be more exact
            expiresAt: (new Date())
          }, transaction.Fulfillment)
        })
        .then(() => {
          debug('emitted!')
        })
    }
  }
}
