export const CATALOG = {
  packages: {
    Mini: { price: 5, deploymentIncluded: '7 days' },
    Classic: { price: 9, deploymentIncluded: '30 days' },
    Deluxe: { price: 14, deploymentIncluded: '3 months' }
  },
  deployments: {
    '30-day extension': 2,
    '90-day extension': 5,
    '1-year extension': 10
  },
  addons: {
    'Extra 10 photos': 1,
    'Extra revision': 2,
    'Custom section': 3,
    'Custom interaction': 4,
    'Rush delivery': 4
  }
};

export function calculateOrder({ packageName, deployment, addons = [] }) {
  const pkg = CATALOG.packages[packageName];
  if (!pkg) throw new Error('Invalid package');
  if (deployment && !(deployment in CATALOG.deployments)) throw new Error('Invalid deployment option');
  if (!Array.isArray(addons)) throw new Error('Invalid add-ons');

  const uniqueAddons = [...new Set(addons)];
  for (const addon of uniqueAddons) {
    if (!(addon in CATALOG.addons)) throw new Error(`Invalid add-on: ${addon}`);
  }

  const deploymentPrice = deployment ? CATALOG.deployments[deployment] : 0;
  const addonTotal = uniqueAddons.reduce((sum, addon) => sum + CATALOG.addons[addon], 0);
  const total = pkg.price + deploymentPrice + addonTotal;

  return {
    packagePrice: pkg.price,
    deploymentPrice,
    addonTotal,
    total: Number(total.toFixed(2)),
    addons: uniqueAddons
  };
}
