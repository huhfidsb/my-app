declare module "@prisma/adapter-better-sqlite3" {
  export class PrismaBetterSqlite3 {
    constructor(
      options: { url: string },
      config?: { timestampFormat?: string },
    );
  }
}
