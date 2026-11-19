export const bcryptPasswordMaxBytes = 72;
export const bcryptPasswordLimitMessage = `Password must be ${bcryptPasswordMaxBytes} UTF-8 bytes or fewer`;
export const newPasswordMinLength = 12;
export const weakPasswordMessage = "Choose a less common password or a longer passphrase";

// A deliberately local, bounded baseline. This is not a complete breach corpus;
// password registration/change must not depend on an external network service.
const commonPasswords = new Set([
  "password", "password1", "password123", "password123!", "password1234",
  "password12345", "password123456", "password123456!", "password12345678",
  "passwordpassword", "passwordpassword1!", "p@ssword123!", "p@ssw0rd123!",
  "123456789012", "1234567890123", "12345678901234", "123456789012345",
  "1234567890123456", "12345678901234567890", "qwertyuiop123",
  "qwertyuiop123!", "qwertyuiopasdfghjkl", "qwerty123456", "qwerty123456!",
  "abcdefghijkl", "abcdefghijklmnopqrstuvwxyz", "letmein123456", "welcome12345",
  "welcome123456", "welcome123456!", "admin12345678", "administrator",
  "brainvault123", "brainvault123!", "brainvault2026", "brainvault2026!"
]);

export function isNewPasswordUncommon(password: string) {
  const comparison = password.normalize("NFKC").trim().toLowerCase();
  return [...comparison].length >= newPasswordMinLength
    && !commonPasswords.has(comparison)
    && !/^(?:qwerty(?:uiop)?|asdfgh(?:jkl)?|zxcvbnm|password|letmein|welcome|admin)[\d\p{P}\p{S}]*$/u.test(comparison)
    && !/^(.{1,4})\1+$/u.test(comparison);
}

export function getPasswordUtf8ByteLength(password: string) {
  return Buffer.byteLength(password, "utf8");
}

export function isPasswordWithinBcryptLimit(password: string) {
  return getPasswordUtf8ByteLength(password) <= bcryptPasswordMaxBytes;
}

export function assertPasswordWithinBcryptLimit(password: string) {
  if (!isPasswordWithinBcryptLimit(password)) {
    throw new RangeError(bcryptPasswordLimitMessage);
  }
}
