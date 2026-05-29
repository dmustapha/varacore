const { GearApi } = require('@gear-js/api');

GearApi.create({ providerAddress: 'wss://testnet.vara.network' }).then(async (api) => {
  await api.isReadyOrError;
  // Decode module 104 error 9 from metadata
  const meta = api.registry;
  // List Gear pallet errors from metadata
  const metadata = await api.rpc.state.getMetadata();
  const pallets = metadata.asLatest.pallets;
  const gearPallet = pallets.find(p => p.index.toNumber() === 104);
  if (gearPallet && gearPallet.errors.isSome) {
    const errType = api.registry.lookup.getTypeDef(gearPallet.errors.unwrap().type);
    process.stdout.write('Gear errors type: ' + JSON.stringify(errType) + '\n');
  }
  // Try direct lookup
  try {
    const gearErrors = api.errors.gear;
    Object.keys(gearErrors).forEach((k, i) => process.stdout.write(i + ': ' + k + '\n'));
  } catch(e) {
    process.stdout.write('errors.gear: ' + e.message + '\n');
  }
  await api.disconnect();
  process.exit(0);
}).catch((e) => { process.stderr.write('ERR: ' + e.message + '\n'); process.exit(1); });
