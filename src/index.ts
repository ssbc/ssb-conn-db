import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {AddressData, ListenEvent, Opts} from './types';
import {migrateMany} from './migration';
const AtomicFile = require('atomic-file');
const Notify = require('pull-notify');
const msAddress = require('multiserver-address');
const debug = require('debug')('ssb:conn-db');

const defaultOpts: Opts = {
  path: path.join(os.homedir(), '.ssb'),
  writeTimeout: 2000,
};

type Updater = (prev: AddressData) => AddressData;

class ConnDB {
  private readonly _map: Map<string, AddressData>;
  private readonly _notify: any;
  private readonly _stateFile: any;
  private readonly _writeTimeout: number;
  private readonly _loadedPromise: Promise<true>;
  private _closed: boolean;
  private _loadedResolve!: (val: true) => void;
  private _loadedReject!: (err: any) => void;
  private _scheduledWriteTask: NodeJS.Timeout | null;

  constructor(opts: Partial<Opts>) {
    const dirPath = opts.path || defaultOpts.path;
    const modernPath = path.join(dirPath, 'conn.json');
    const legacyPath = path.join(dirPath, 'gossip.json');
    this._map = new Map<string, AddressData>();
    this._notify = Notify();
    this._stateFile = AtomicFile(modernPath);
    this._writeTimeout =
      typeof opts.writeTimeout === 'number'
        ? opts.writeTimeout
        : defaultOpts.writeTimeout;
    this._scheduledWriteTask = null;
    this._closed = false;
    this._loadedPromise = new Promise((resolve, reject) => {
      this._loadedResolve = resolve;
      this._loadedReject = reject;
    });
    this._init(modernPath, legacyPath);
  }

  //#region INTERNAL

  private _init(modernPath: string, legacyPath: string) {
    const modernExists = fs.existsSync(modernPath);
    const legacyExists = fs.existsSync(legacyPath);

    if (!modernExists && !legacyExists) {
      this._stateFile.set({}, () => {});
      this._loadedResolve(true);
      debug(
        'Created new conn.json because there was no existing ' +
          'conn.json nor gossip.json',
      );
      return;
    }

    if (!modernExists && legacyExists) {
      const legacyStateFile = AtomicFile(legacyPath);
      legacyStateFile.get((err: any, oldVals: any) => {
        if (err) {
          this._loadedReject(err);
          debug('Failed to load gossip.json, for creating conn.json');
          return;
        }
        const newVals = migrateMany(oldVals);
        return this._stateFile.set(newVals, (err2: any) => {
          if (err2) {
            this._loadedReject(err2);
            debug('Failed to create conn.json from an existing gossip.json');
            return;
          }
          debug('Migrated gossip.json into conn.json');
          this._load(newVals);
        });
      });
      return;
    }

    if (modernExists) {
      this._stateFile.get((err: any, vals: any) => {
        if (err) {
          this._loadedReject(err);
          debug('Failed to load conn.json');
          return;
        }
        this._load(vals);
      });
    }
  }

  private _load(vals: Record<string, AddressData>): void {
    const keys = Object.keys(vals);
    for (let key of keys) {
      this._map.set(key, vals[key]);
    }
    this._loadedResolve(true);
    debug('Loaded conn.json into ConnDB in memory');
  }

  private _serialize(): Record<string, AddressData> {
    const record: Record<string, AddressData> = {};
    for (let [address, data] of this._map.entries()) {
      record[address] = data;
    }
    return record;
  }

  private _write(cb?: (err: any) => void): void {
    debug('Begun serializing and writing ConnDB into conn.json');
    const record = this._serialize();
    this._stateFile.set(record, (err: any) => {
      if (!err) debug('Done serializing and writing ConnDB into conn.json');
      if (cb) cb(err);
    });
  }

  private _cancelScheduleWrite(): void {
    if (this._scheduledWriteTask) {
      clearTimeout(this._scheduledWriteTask);
    }
  }

  private _scheduleWrite(): void {
    this._cancelScheduleWrite();
    this._scheduledWriteTask = setTimeout(() => {
      this._write((_err: any) => {
        this._scheduledWriteTask = null;
      });
    }, this._writeTimeout);
  }

  private _assertNotClosed() {
    if (this._closed) {
      throw new Error('This ConnDB instance is closed, create a new one.');
    }
  }

  private _assertValidAddress(address: string) {
    if (!msAddress.check(address)) {
      throw new Error('The given address is not a valid multiserver-address');
    }
  }

  private _assertValidData(data: AddressData) {
    if (!data || typeof data !== 'object') {
      throw new Error('The given connection data should have been an object');
    }
  }

  //#endregion

  //#region PUBLIC API

  public replace(address: string, data: AddressData): ConnDB {
    this._assertNotClosed();
    this._assertValidAddress(address);
    this._assertValidData(data);

    const existed = this._map.has(address);
    if (existed) {
      const {birth} = this._map.get(address)!;
      this._map.set(address, {birth: birth || Date.now(), ...data});
      this._notify({type: 'update', address} as ListenEvent);
    } else {
      this._map.set(address, {birth: Date.now(), ...data});
      this._notify({type: 'insert', address} as ListenEvent);
    }
    this._scheduleWrite();
    return this;
  }

  public set(address: string, data: AddressData): ConnDB {
    this._assertNotClosed();
    this._assertValidAddress(address);
    this._assertValidData(data);

    const existed = this._map.has(address);
    if (existed) {
      const previous = this._map.get(address)!;
      this._map.set(address, {
        birth: previous.birth || Date.now(),
        ...previous,
        ...data,
      });
      this._notify({type: 'update', address} as ListenEvent);
    } else {
      this._map.set(address, {birth: Date.now(), ...data});
      this._notify({type: 'insert', address} as ListenEvent);
    }
    this._scheduleWrite();
    return this;
  }

  public update(address: string, x: AddressData | Updater): ConnDB {
    this._assertNotClosed();
    this._assertValidAddress(address);
    if (!x || (typeof x !== 'object' && typeof x !== 'function')) {
      throw new Error('update() expects an object or a function');
    }

    const existed = this._map.has(address);
    if (!existed) return this;

    const previous = this._map.get(address)!;
    const next = typeof x === 'function' ? x(previous) : x;
    this._map.set(address, {
      birth: previous.birth || Date.now(),
      ...previous,
      ...next,
    });
    this._notify({type: 'update', address} as ListenEvent);
    this._scheduleWrite();
    return this;
  }

  public get(address: string): AddressData | undefined {
    this._assertNotClosed();

    return this._map.get(address);
  }

  public getAddressForId(id: string): string | undefined {
    this._assertNotClosed();

    for (let [address, data] of this._map.entries()) {
      if (data.key === id) return address;
    }
    return undefined;
  }

  public has(address: string): boolean {
    this._assertNotClosed();

    return this._map.has(address);
  }

  public delete(address: string): boolean {
    this._assertNotClosed();

    const hasDeleted = this._map.delete(address);
    if (hasDeleted) {
      this._notify({type: 'delete', address} as ListenEvent);
      this._scheduleWrite();
    }
    return hasDeleted;
  }

  public entries() {
    this._assertNotClosed();

    return this._map.entries();
  }

  public listen() {
    this._assertNotClosed();

    return this._notify.listen();
  }

  public loaded(): Promise<true> {
    this._assertNotClosed();

    return this._loadedPromise;
  }

  public close() {
    this._cancelScheduleWrite();
    this._write();
    this._closed = true;
    this._map.clear();
    (this as any)._map = null;
    (this as any)._notify = null;
    (this as any)._stateFile = null;
    debug('Closed the ConnDB instance');
  }

  //#endregion
}

export = ConnDB;
