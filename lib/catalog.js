const PACKAGES = {
  Mini: 5,
  Classic: 9,
  Deluxe: 15
};

const DEPLOYMENTS = {
  '30-day extension': 2,
  '90-day extension': 5,
  '1-year extension': 10
};

const ADDONS = {
  'Extra 10 photos': 1,
  'Extra revision': 2,
  'Custom section': 3,
  'Custom interaction': 4,
  'Rush delivery': 4
};

export function calculateOrder({ packageName, deployment, addons = [] }) {
  if (!Object.prototype.hasOwnProperty.call(PACKAGES, packageName)) {
    throw new Error('Invalid package');
  }

  const normalizedAddons = Array.isArray(addons) ? [...new Set(addons)] : [];
  const unknownAddons = normalizedAddons.filter(name => !Object.prototype.hasOwnProperty.call(ADDONS, name));
  if (unknownAddons.length) throw new Error(`Invalid add-on: ${unknownAddons[0]}`);
  if (deployment && !Object.prototype.hasOwnProperty.call(DEPLOYMENTS, deployment)) {
    throw new Error('Invalid deployment option');
  }

  const packageTotal = PACKAGES[packageName];
  const deploymentTotal = deployment ? DEPLOYMENTS[deployment] : 0;
  const addonItems = normalizedAddons.map(name => ({ name, price: ADDONS[name] }));
  const addonTotal = addonItems.reduce((sum, item) => sum + item.price, 0);
  const total = Number((packageTotal + deploymentTotal + addonTotal).toFixed(2));

  return {
    packageName,
    packagePrice: packageTotal,
    deployment: deployment || null,
    deploymentPrice: deploymentTotal,
    addons: addonItems,
    total
  };
}
