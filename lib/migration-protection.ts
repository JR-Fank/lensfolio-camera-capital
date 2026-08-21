export const MIGRATION_PROTECTION_MESSAGE = "System is under migration protection.";
export const AUTHENTICATION_REQUIRED_MESSAGE = "Authentication required.";

export type MigrationEnvironment = {
  MIGRATION_READ_ONLY?: string | boolean;
};

export function isMigrationReadOnly(environment: MigrationEnvironment) {
  return String(environment.MIGRATION_READ_ONLY ?? "false").trim().toLowerCase() === "true";
}
