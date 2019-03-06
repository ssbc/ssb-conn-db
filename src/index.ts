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

class ConnDB {
  private readonly _map: Map<string, AddressData>;
  private readonly _notify: any;
  private readonly _stateFile: any;
  private readonly _writeTimeout: number;
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
    this._init(modernPath, legacyPath);
  }

  private _init(modernPath: string, legacyPath: string) {
    const modernExists = fs.existsSync(modernPath);
    const legacyExists = fs.existsSync(legacyPath);

    if (!modernExists && !legacyExists) {
      this._stateFile.set({}, () => {});
      return;
    }

    if (!modernExists && legacyExists) {
      const legacyStateFile = AtomicFile(legacyPath);
      legacyStateFile.get((err: any, oldVals: any) => {
        if (err) throw new Error('Failed to load gossip.json');
        const newVals = migrateMany(oldVals);
        return this._stateFile.set(newVals, (_err2: any) => {
          this._load(newVals);
        });
      });
      return;
    }

    if (modernExists) {
      this._stateFile.get((_err: any, vals: any) => {
        this._load(vals);
      });
    }
  }

  private _load(vals: Record<string, AddressData>): void {
    const keys = Object.keys(vals);
    for (let key of keys) {
      this._map.set(key, vals[key]);
    }
  }

  private _serialize(): Record<string, AddressData> {
    const record: Record<string, AddressData> = {};
    for (let [address, data] of this._map.entries()) {
      record[address] = data;
    }
    return record;
  }

  private _scheduleWrite(): void {
    if (this._scheduledWriteTask) {
      clearTimeout(this._scheduledWriteTask);
    }
    this._scheduledWriteTask = setTimeout(() => {
      const record = this._serialize();
      this._stateFile.set(record, (_err: any) => {
        this._scheduledWriteTask = null;
      });
    }, this._writeTimeout);
  }

  ///////////////
  //// PUBLIC API
  ///////////////

  public replace(address: string, data: AddressData): ConnDB {
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

  public update(address: string, data: AddressData): ConnDB {
    if (!msAddress.check(address)) {
      throw new Error('The given address is not a valid multiserver-address');
    }
    if (!data || typeof data !== 'object') {
      throw new Error('The given connection data should have been an object');
    }

    const existed = this._map.has(address);
    if (!existed) return this;

    const previous = this._map.get(address);
    this._map.set(address, {...previous, ...data});
    this._notify({type: 'update', address} as ListenEvent);
    this._scheduleWrite();
    return this;
  }

  public get(address: string): AddressData {
    return this._map.get(address);
  }

  public has(address: string): boolean {
    return this._map.has(address);
  }

  public delete(address: string): boolean {
    const hasDeleted = this._map.delete(address);
    if (hasDeleted) {
      this._notify({type: 'delete', address} as ListenEvent);
      this._scheduleWrite();
    }
    return hasDeleted;
  }

  public entries() {
    return this._map.entries();
  }

  public listen() {
    return this._notify.listen();
  }
}

export = ConnDB;
