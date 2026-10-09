/** Share authoritative store reads only within one catalogue request. */
export function createSessionListSnapshot(readers) {
  const values = new Map();
  return Object.defineProperties({}, Object.fromEntries(
    Object.entries(readers).map(([name, read]) => [name, {
      get() {
        if (!values.has(name)) values.set(name, read());
        return values.get(name);
      },
    }]),
  ));
}
