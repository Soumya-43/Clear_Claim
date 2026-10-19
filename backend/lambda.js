const serverlessExpress = require("@codegenie/serverless-express");
const { app, initPromise } = require("./server");

let serverlessExpressInstance;

async function setup(event, context) {
  await initPromise;
  serverlessExpressInstance = serverlessExpress({ app });
  return serverlessExpressInstance(event, context);
}

exports.handler = async (event, context) => {
  if (serverlessExpressInstance) {
    return serverlessExpressInstance(event, context);
  }
  return setup(event, context);
};
