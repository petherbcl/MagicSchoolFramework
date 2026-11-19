// Public API of ms-sql: `Exports.get("ms-sql", "Sql")`.
// Placeholders: `?` with an array, or `:name` with an object (never mixed in one query).
// BIGINT columns and insert ids are decimal strings. `undefined` parameters are sent as NULL, arrays and
// plain objects are sent as JSON text.

export type SqlDialect = "postgres" | "mysql" | "mariadb";
export type SqlParams = readonly unknown[] | Record<string, unknown>;

export type SqlErrorKind =
  | "UNIQUE_VIOLATION" | "FOREIGN_KEY_VIOLATION" | "DEADLOCK" | "TIMEOUT" | "CONNECTION"
  | "SYNTAX" | "INVALID_PARAMS" | "INSERT_REQUIRED" | "NOT_READY" | "OTHER";

export declare class SqlError extends Error {
  readonly name: "SqlError";
  readonly code: "SQL_ERROR";
  readonly kind: SqlErrorKind;
  /** Constraint or index name (UNIQUE_VIOLATION, FOREIGN_KEY_VIOLATION), otherwise null. */
  readonly constraint: string | null;
  readonly sqlState: string | null;
  /** Driver specific code, e.g. "23505" or "ER_DUP_ENTRY". */
  readonly driverCode: string | null;
  /** The original driver error. Server side only: it may contain values. */
  readonly cause?: unknown;
}

/** Result of a statement that returns no rows. insertId is a string, or null when there is none. */
export interface SqlHeader { affectedRows: number; insertId: string | null; changedRows: number }
export type SqlRow = Record<string, any>;
export type SqlResult = SqlRow[] | SqlHeader;

export interface InsertOptions {
  /** PostgreSQL only: column appended as RETURNING when the INSERT has none. Default "id". Validated against /^[A-Za-z_][A-Za-z0-9_]{0,62}$/. */
  returning?: string;
}

export interface SqlExecutor {
  /** SELECT or anything that returns rows (including RETURNING): array of rows. Otherwise a header. */
  query(sql: string, params?: SqlParams): Promise<SqlResult>;
  /** First row or null. */
  single<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): Promise<T | null>;
  /** First column of the first row, or null. */
  scalar<T = any>(sql: string, params?: SqlParams): Promise<T | null>;
  /** Runs an INSERT and returns the new id as a string (or null). Throws INSERT_REQUIRED for other statements. */
  insert(sql: string, params?: SqlParams, options?: InsertOptions): Promise<string | null>;
  /** UPDATE or DELETE: number of matched rows. */
  update(sql: string, params?: SqlParams): Promise<number>;
  /** Like query, executed as a prepared statement. */
  prepare(sql: string, params?: SqlParams): Promise<SqlResult>;
  /** Runs the statement once per parameter set, in order, on one connection. Not atomic outside a transaction. */
  rawExecute(sql: string, paramSets: readonly SqlParams[]): Promise<SqlResult[]>;
}

/** Handed to transaction() and withLock() callbacks. Unusable once the scope ends. No nested transactions. */
export interface SqlTransaction extends SqlExecutor {
  transaction(...args: never[]): never;
}

export interface TransactionStatement { query: string; values?: SqlParams }

export interface Sql extends SqlExecutor {
  readonly dialect: SqlDialect | null;
  /** Configured MS_SQL_SCHEMA (PostgreSQL schema, MySQL/MariaDB database). Unqualified table names resolve inside it. Null when no database is configured. */
  readonly schema: string | null;
  /** Commits when fn resolves, rolls back (and rethrows the original error) when it rejects. */
  transaction<T>(fn: (tx: SqlTransaction) => Promise<T> | T): Promise<T>;
  /** Runs all statements in one transaction. Resolves true after commit, rejects with a SqlError otherwise. */
  transaction(statements: readonly TransactionStatement[]): Promise<true>;
  /** Exclusive application lock (name max 64 chars) on a dedicated connection. Rejects with TIMEOUT if not obtained. */
  withLock<T>(name: string, fn: (tx: SqlTransaction) => Promise<T> | T, timeoutMs?: number): Promise<T>;
  /** Synchronous, never throws. */
  isReady(): boolean;
  /** Resolves true once ready. Rejects with TIMEOUT after timeoutMs, or NOT_READY if no database is configured. */
  awaitConnection(timeoutMs?: number): Promise<true>;
}

/** What createSql returns: the public API plus close() for the owning resource only. */
export interface SqlOwner extends Sql { close(): Promise<void> }
