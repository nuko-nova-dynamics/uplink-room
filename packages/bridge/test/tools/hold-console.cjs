// For the bridge's Windows console tests (#66): writes this process's pid to the file named by the
// first argument and waits until stopped, attached to whatever console it was started in.
require("node:fs").writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 60_000);
