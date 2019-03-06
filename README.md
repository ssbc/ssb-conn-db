# ssb-conn-db

Module that manages a local registry of connectable peers. For use with the SSB CONN family of modules.

## Usage

This module is only used to create an SSB CONN plugin, not used directly by applications.

```js
const ConnDB = require('ssb-conn-db')

const connPlugin = {
  name: 'conn',
  version: '1.0.0',
  manifest: {
    add: 'sync'
  },
  init: function(server) {
    const connDB = new ConnDB({path: 'path/to/directory'});
    return {
      add: function(address, data) {
        // NOTICE THIS
        connDB.set(address, data);
      },
    };
  }
};
```

## API

* `new ConnDB(opts)`: constructor for a connDB instance, with the following options:
  - `opts.path` (default `'~/.ssb'`): path to the directory where the database will be stored
  - `opts.writeTimeout` (default `2000` milliseconds): interval to wait when batching database writes in the filesystem
* `connDB.set(address, data)`: register or update a connectable peer by its `address` (string, must conform to the [multiserver address convention](https://github.com/dominictarr/multiserver-address)) with `data` (object). If updating the data, it will *merge* the previous properties with the new properties. Returns the `connDB` instance.
* `connDB.replace(address, data)`: register or update a connectable peer by its `address` (string, must conform to the [multiserver address convention](https://github.com/dominictarr/multiserver-address)) with `data` (object). If updating the data, it will *replace* the previous properties with the new properties. Returns the `connDB` instance.
* `connDB.get(address)`: returns the data for an existing peer with the given `address`, or `undefined` if the address was not registered
* `connDB.has(address)`: returns `true` if the given `address` is registered in the database, `false` otherwise
* `connDB.delete(address)`: remove an address and its associated data from the database. Returns `true` if the address existed and was deleted, `false` otherwise.
* `connDB.entries()`: returns a new `Iterator` object that gives `[address, data]` pairs
* `connDB.listen()`: returns a pull stream that notifies of changes made to the database, as an object `{type, address}` where `type` is either `'insert'`, `'update'`, or `'delete'`

Notice that the API above mostly mirrors the API of the JavaScript [Map](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map).

## License

MIT
