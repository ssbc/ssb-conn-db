import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {AddressData, ListenEvent, Opts} from './types';
import {migrateMany} from './migration';
const AtomicFile = require('atomic-file');
const Notify = require('pull-notify');
const msAddress = require('multiserver-address');

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

  private _init(modernPath: string, legacyPath: string) {
    const modernExists = fs.existsSync(modernPath);
    const legacyExists = fs.existsSync(legacyPath);

    if (!modernExists && !legacyExists) {
      this._stateFile.set({}, () => {});
      this._loadedResolve(true);
      return;
    }

    if (!modernExists && legacyExists) {
      const legacyStateFile = AtomicFile(legacyPath);
      legacyStateFile.get((err: any, oldVals: any) => {
        if (err) {
          this._loadedReject(err);
          return;
        }
        const newVals = migrateMany(oldVals);
        return this._stateFile.set(newVals, (err2: any) => {
          if (err2) {
            this._loadedReject(err2);
            return;
          }
          this._load(newVals);
        });
      });
      return;
    }

    if (modernExists) {
      this._stateFile.get((err: any, vals: any) => {
        if (err) {
          this._loadedReject(err);
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
  }

  private _serialize(): Record<string, AddressData> {
    const record: Record<string, AddressData> = {};
    for (let [address, data] of this._map.entries()) {
      record[address] = data;
    }
    return record;
  }

  private _write(cb?: (err: any) => void): void {
    const record = this._serialize();
    this._stateFile.set(record, cb || (() => {}));
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

  ///////////////
  //// PUBLIC API
  ///////////////

  public replace(address: string, data: AddressData): ConnDB {
    if (this._closed) {
      throw new Error('This ConnDB instance is closed, create a new one.');
    }
    if (!msAddress.check(address)) {
      throw new Error('The given address is not a valid multiserver-address');
    }
    if (!data || typeof data !== 'object') {
      throw new Error('The given connection data should have been an object');
    }

    const existed = this._map.has(address);
    this._map.set(address, data);
    if (existed) {
      this._notify({type: 'update', address} as ListenEvent);
    } else {
      this._notify({type: 'insert', address} as ListenEvent);
    }
    this._scheduleWrite();
    return this;
  }

  public set(address: string, data: AddressData): ConnDB {
    if (this._closed) {
      throw new Error('This ConnDB instance is closed, create a new one.');
    }
    if (!msAddress.check(address)) {
      throw new Error('The given address is not a valid multiserver-address');
    }
    if (!data || typeof data !== 'object') {
      throw new Error('The given connection data should have been an object');
    }

    const existed = this._map.has(address);
    if (existed) {
      const previous = this._map.get(address);
      this._map.set(address, {...previous, ...data});
      this._notify({type: 'update', address} as ListenEvent);
    } else {
      this._map.set(address, data);
      this._notify({type: 'insert', address} as ListenEvent);
    }
    this._scheduleWrite();
    return this;
  }

  public update(address: string, x: AddressData | Updater): ConnDB {
    if (this._closed) {
      throw new Error('This ConnDB instance is closed, create a new one.');
    }
    if (!msAddress.check(address)) {
      throw new Error('The given address is not a valid multiserver-address');
    }
    if (!x || (typeof x !== 'object' && typeof x !== 'function')) {
      throw new Error('update() expects an object or a function');
    }

    const existed = this._map.has(address);
    if (!existed) return this;

    const previous = this._map.get(address);
    const next = typeof x === 'function' ? x(previous) : x;
    this._map.set(address, {...previous, ...next});
    this._notify({type: 'update', address} as ListenEvent);
    this._scheduleWrite();
    return this;
  }

  public get(address: string): AddressData {
    if (this._closed) {
      throw new Error('This ConnDB instance is closed, create a new one.');
    }
    return this._map.get(address);
  }

  public getAddressForId(id: string): string | undefined {
    if (this._closed) {
      throw new Error('This ConnDB instance is closed, create a new one.');
    }
    for (let [address, data] of this._map.entries()) {
      if (data.key === id) return address;
    }
    return undefined;
  }

  public has(address: string): boolean {
    if (this._closed) {
      throw new Error('This ConnDB instance is closed, create a new one.');
    }
    return this._map.has(address);
  }

  public delete(address: string): boolean {
    if (this._closed) {
      throw new Error('This ConnDB instance is closed, create a new one.');
    }
    const hasDeleted = this._map.delete(address);
    if (hasDeleted) {
      this._notify({type: 'delete', address} as ListenEvent);
      this._scheduleWrite();
    }
    return hasDeleted;
  }

  public entries() {
    if (this._closed) {
      throw new Error('This ConnDB instance is closed, create a new one.');
    }
    return this._map.entries();
  }

  public listen() {
    if (this._closed) {
      throw new Error('This ConnDB instance is closed, create a new one.');
    }
    return this._notify.listen();
  }

  public loaded(): Promise<true> {
    if (this._closed) {
      throw new Error('This ConnDB instance is closed, create a new one.');
    }
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
  }
}

export = ConnDB;
