const storeName = "keys";

async function useKeyStore(mode, target, action) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("brainvault-encrypted-collections", 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("The browser's collection key store is busy"));
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName), JSON.stringify(target));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error);
    });
  } finally {
    db.close();
  }
}

// The non-extractable key is local to this browser profile and application
// origin. TOTP authorizes the separate server request for the ciphertext.
export const deviceCollectionKeys = {
  has: (target) => useKeyStore("readonly", target, (store, id) => store.getKey(id)).then(Boolean),
  read: (target) => useKeyStore("readonly", target, (store, id) => store.get(id)),
  remember: (target, key) => useKeyStore("readwrite", target, (store, id) => store.put(key, id)),
  forget: (target) => useKeyStore("readwrite", target, (store, id) => store.delete(id))
};
