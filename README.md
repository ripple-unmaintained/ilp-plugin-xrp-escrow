# ILP Plugin XRP Escrow
> ILP ledger plugin using the escrow features of ripple

**NOTE**: This plugin is under development, and should not yet be used
with funds of over ~ 0.01 USD in value.

## Step 1: create a hot wallet.

This can easily be done with:
```sh
npm install
node ./scripts/genKeyPair.js
```

Store your hot wallet secret (seed) in a text file.
Use your hot wallet account (address) in the next step.

For security reasons, and because we're mainly looking at micropayments here anyway,
make sure your hot wallet balance never exceeds ~ 0.01 USD.
See [Issuing and Operational Addresses](https://ripple.com/build/issuing-operational-addresses/)
for more information on how to use hot/warm/cold wallets.

## Step 2: fund your hot wallet with some XRP drops.

```sh
npm install -g wscat
wscat -c wss://s1.ripple.com
connected (press CTRL+C to quit)
> {"command":"account_info","account":"raymJpdRBoqLjJ7vhLnjo7GFLYrG8j3yey"}
< {"account":"raymJpdRBoqLjJ7vhLnjo7GFLYrG8j3yey","error":"actNotFound","error_code":18,"error_message":"Account not found.","ledger_current_index":29171107,"request":{"account":"raymJpdRBoqLjJ7vhLnjo7GFLYrG8j3yey","command":"account_info"},"status":"error","type":"response","validated":false}
```

Someone will have to send you some XRP drops to play around with.
Ask in https://gitter.im/interledger/Lobby.
Now, when you run the `account_info` command again in wscat, you should see something more like this:

```sh
> {"command":"account_info","account":"raymJpdRBoqLjJ7vhLnjo7GFLYrG8j3yey"}
< {"result":{"account_data":{"Account":"raymJpdRBoqLjJ7vhLnjo7GFLYrG8j3yey","Balance":"50000000","Flags":0,"LedgerEntryType":"AccountRoot","OwnerCount":0,"PreviousTxnID":"0000000000000000000000000000000000000000000000000000000000000000","PreviousTxnLgrSeq":0,"Sequence":1,"index":"9B8BF54B62E8A0C9D1BB46CB11A8417479EEA90FFAF9D128E9C66E709A430A60"},"ledger_current_index":29171125,"validated":false},"status":"success","type":"response"}
```

## Step 3: instantiate the plugin.

Now that you have a Ripple wallet, you can use it in combination with other
ILP-related npm modules (e.g. `ilp-connector`), as follows:

```js
const PluginXrpEscrow = require('ilp-plugin-xrp-escrow')

const plugin = new PluginXrpEscrow({
  secret: '<your hot wallet secret>',
  server: 'wss://s1.ripple.com'
})
```

Requires node 7 or higher, to support async/await.
