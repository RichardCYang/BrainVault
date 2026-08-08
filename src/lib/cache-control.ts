export const privateNoStoreCacheControl = "private, no-store";

type HeaderWriter = {
  setHeader(name: string, value: string): unknown;
};

export function setPrivateNoStoreCacheControl(response: HeaderWriter) {
  response.setHeader("Cache-Control", privateNoStoreCacheControl);
}
