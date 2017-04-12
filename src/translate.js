'use strict'
const Condition = require('./condition')

const ID_REL = 'https://interledger.org/rel/xrpId'
const ILP_REL = 'https://interledger.org/rel/xrpIlp'
const MESSAGE_REL = 'https://interledger.org/rel/xrpMessage'

function rippleToISO (rippleTime) {
  const timestamp = (rippleTime + 0x386D4380) * 1000
  return new Date(timestamp).toISOString()
}

function parseEscrow (event) {
  for (const entry of (event.meta.AffectedNodes || [])) {
    //console.log('\x1b[32mESCROW\x1b[39m', JSON.stringify(entry, null, 2))
    for (const nodeType of ['DeletedNode', 'CreatedNode']) {
      if (entry[nodeType] &&
        entry[nodeType].LedgerEntryType === 'Escrow') {
        return {
          node: entry[nodeType].NewFields || entry[nodeType].FinalFields,
          index: entry[nodeType].LedgerIndex
        }
      }
    }
  }
}

function parseMemos (rawMemos) {
  const memos = {}
  for (const m of (rawMemos || [])) {
    const type = Buffer.from(m.Memo.MemoType, 'hex').toString('utf8')
    memos[type] = Buffer.from(m.Memo.MemoData, 'hex')
  }
  return memos
}

function getDirection (plugin, transaction) {
  if (transaction.Account === plugin._address) return 'outgoing'
  if (transaction.Destination === plugin._address) return 'incoming'
  throw new Error('tried to parse direction from invalid tx:' +
    JSON.stringify(event))
}

function * escrowToTransfer (plugin, event) {
  const escrow = parseEscrow(event)
  const transaction = event.transaction

  if (transaction.Memos) {
    plugin._transfers[escrow.index] = {
      Account: transaction.Account,
      Memos: transaction.Memos,
      Sequence: transaction.Sequence
    }
  }

  const cached = plugin._transfers[escrow.index]
  const memos = parseMemos(cached.Memos)
  const id = memos[ID_REL].toString('utf8')
  const ilp = memos[ILP_REL].toString('utf8')

  // keep two references, so the plugin and the translator can access
  plugin._transfers[id] = plugin._transfers[escrow.index]
  
  return {
    id: id,
    to: plugin._prefix + escrow.node.Destination,
    from: plugin._prefix + escrow.node.Account,
    direction: getDirection(plugin, escrow.node),
    ledger: plugin._prefix,
    amount: escrow.node.Amount,
    ilp: ilp,
    executionCondition: Condition.rippleToCondition(escrow.node.Condition),
    noteToSelf: plugin._notesToSelf[id],
    // TODO: this needs to be parsed from ripple timestamp
    expiresAt: rippleToISO(escrow.node.CancelAfter)
  }
}

function * escrowCreateToTransfer (plugin, event) {
  return yield escrowToTransfer(plugin, event)
}

function * escrowFinishToTransfer (plugin, event) {
  return yield escrowToTransfer(plugin, event)
}

function * escrowCancelToTransfer (plugin, event) {
  return yield escrowToTransfer(plugin, event)
}

function paymentToMessage (plugin, event) {
  const transaction = event.transaction
  const memos = parseMemos(transaction.Memos)
  const messageData = memos[MESSAGE_REL]

  return {
    data: JSON.parse(messageData.toString('utf8')),
    to: transaction.Account,
    from: transaction.Destination,
    ledger: plugin._prefix,
    direction: getDirection(plugin, transaction)
  }
}

module.exports = {
  paymentToMessage,
  parseEscrow,
  rippleToISO,
  escrowCreateToTransfer,
  escrowFinishToTransfer,
  escrowCancelToTransfer
}
