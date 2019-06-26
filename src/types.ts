export type Opts = {
  readonly path: string;
  readonly writeTimeout: number;
};

export type Statistics = {
  mean: number;
  stdev: number;
  count: number;
  sum: number;
  sqsum: number;
};

export type AddressData = {
  birth?: number;
  key?: string;
  source?: string;
  failure?: number;
  stateChange?: number;
  duration?: Statistics;
  ping?: {
    rtt: Statistics;
    skew: Statistics;
  };

  [name: string]: any;
};

export type ListenEvent = {
  type: 'insert' | 'update' | 'delete';
  address: string;
};
