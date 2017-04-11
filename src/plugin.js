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
//    this.sendMessage = co.wrap(this._sendMessage).bind(this)
  }

  * _connect () {
    debug('connecting to api')
    yield this._api.connect()
    debug('subscribing to account notifications')
    yield this._api.connection.request({
      command: 'subscribe',
      accounts: [ this._address ]
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
      allowExecuteAfter: (new Date()).toISOString(),
      condition: hexCondition.toUpperCase(),
      memos: [{
        type: 'https://interledger.org/rel/xrpTransfer',
        data: transfer.ilp
      }, {
        type: 'https://interledger.org/rel/xrpId',
        data: transfer.id
      }]
    })

    /*
    const tx = yield this._api.prepareEscrowCreation(this._address, {
      "destination": "rpZc4mVfWUif9CRoHRKKcmhu1nx2xktxBo",
      "amount": "0.01",
      "condition": "8F434346648F6B96DF89DDA901C5176B",
      "allowExecuteAfter": "2014-09-24T21:21:50.000Z",
      "memos": [
        {
          "type": "test",
          "data": "texted data"
        }
      ],
      "allowCancelAfter": "2018-09-24T21:21:50.000Z"
    })*/

    const signed = this._api.sign(tx.txJSON, this._secret)
    debug('signing and submitting transaction: ' + tx.txJSON)
    debug('transaction id of', transfer.id, 'is', signed.id)

    yield this._api.submit(signed.signedTransaction)
    debug('submitted transaction')
  }

  * _fulfillCondition (transferId, fulfillment) {

  }
}
