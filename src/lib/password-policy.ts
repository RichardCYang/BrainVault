export const bcryptPasswordMaxBytes = 72;
export const bcryptPasswordLimitMessage = `Password must be ${bcryptPasswordMaxBytes} UTF-8 bytes or fewer`;

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
