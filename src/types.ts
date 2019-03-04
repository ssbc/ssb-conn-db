export type Opts = {
  readonly path: string;
  readonly writeTimeout: number;
};

export type AddressData = any;

export type ListenEvent = {
  type: 'insert' | 'update' | 'delete';
  address: string;
};
