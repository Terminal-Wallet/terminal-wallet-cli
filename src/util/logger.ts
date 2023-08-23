export default class Logger {
  namespace: string;

  constructor(namespace: string) {
    this.namespace = namespace;
  }

  log(obj: any) {
    console.log(`terminal-cli:${this.namespace}: ${obj}`);
  }
  warn(obj: any) {
    console.warn(`terminal-cli:WARN:${this.namespace}: ${obj}`);
  }
  error(obj: Error) {
    console.error(`terminal-cli:ERROR:${this.namespace}: ${obj}`);
  }
}
