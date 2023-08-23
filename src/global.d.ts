declare type Optional<T> = T | undefined | null;
declare type MapType<T> = { [id: string]: T };
declare type NumMapType<T> = { [index: number]: T };
declare module "snarkjs";
