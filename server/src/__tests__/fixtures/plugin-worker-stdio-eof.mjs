import { definePlugin, startWorkerRpcHost } from "@paperclipai/plugin-sdk";

startWorkerRpcHost({ plugin: definePlugin({}) });
process.stderr.write("SPS_TEST_SDK_WORKER_READY\n");
