'use strict'

const Errors = require('./errors')
const debug = require('debug')('ilp-plugin-xrp-escrow:submitter')

function * submit (api, signed) {
  const { signedTransaction } = signed
  const txHash = signed.id

  const result = new Promise((resolve, reject) => {
    function handleTransactionResult (ev) {
      if (!ev.validated) return
      if (!ev.transaction || ev.transaction.hash !== txHash) return

      // whether it was success or not, clean up the listener
      api.removeListener('transaction', handleTransactionResult)

      // give detailed error on failure
      if (ev.engine_result !== 'tesSUCCESS') {
        reject(new Errors.NotAcceptedError('transaction with hash "' +
          txHash + '" failed with engine result: ' +
          JSON.stringify(ev)))
      }

      // no info returned on success
      resolve(null)
    }

    api.connection.on('transaction', handleTransactionResult)
  })

  yield api.submit(signedTransaction)
  debug('submitted transaction', txHash)

  yield result
}

module.exports = { submit }
