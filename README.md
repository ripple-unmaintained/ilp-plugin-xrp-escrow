# ILP Plugin XRP Escrow
> ILP ledger plugin using the escrow features of ripple

**NOTE**: This plugin is under development, and should not yet be used in
production or with funds on the live network.

```js
const PluginXrpEscrow = require('ilp-plugin-xrp-escrow')

const plugin = new PluginXrpEscrow({
  secret: 'snwTzJeLvmCdTK2euyiiCACPL9JqU',
  server: 'wss://s.altnet.rippletest.net:51233'
})
```

Requires node 7 or higher, to support async/await.
