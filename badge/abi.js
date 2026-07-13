// EigenCompute environment constants + the AppUpgraded event ABI.
// Addresses/URLs match @layr-labs/ecloud-sdk (environment.ts) as of 2026-07-12.

// Several RPCs per network: free endpoints disagree — one mainnet provider
// returned an empty (not error!) result for a block that provably contains
// the AppUpgraded event. The verifier treats "no logs where the contract
// says a release exists" as a lying RPC and tries the next one.
export const ENVIRONMENTS = {
  'sepolia-dev': {
    appController: '0xa86DC1C47cb2518327fB4f9A1627F51966c83B92',
    userApi: 'https://userapi-compute-sepolia-dev.eigencloud.xyz',
    rpcs: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://sepolia.drpc.org',
      'https://1rpc.io/sepolia',
    ],
    explorerTx: 'https://sepolia.etherscan.io/tx/',
    dashboardApp: 'https://verify-sepolia.eigencloud.xyz/app/',
  },
  sepolia: {
    appController: '0x0dd810a6ffba6a9820a10d97b659f07d8d23d4E2',
    userApi: 'https://userapi-compute-sepolia-prod.eigencloud.xyz',
    rpcs: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://sepolia.drpc.org',
      'https://1rpc.io/sepolia',
    ],
    explorerTx: 'https://sepolia.etherscan.io/tx/',
    dashboardApp: 'https://verify-sepolia.eigencloud.xyz/app/',
  },
  'mainnet-alpha': {
    appController: '0xc38d35Fc995e75342A21CBd6D770305b142Fbe67',
    userApi: 'https://userapi-compute.eigencloud.xyz',
    rpcs: [
      'https://eth.drpc.org',
      'https://1rpc.io/eth',
      'https://ethereum-rpc.publicnode.com',
    ],
    explorerTx: 'https://etherscan.io/tx/',
    dashboardApp: 'https://verify.eigencloud.xyz/app/',
  },
};

const rmsRelease = {
  name: 'rmsRelease',
  type: 'tuple',
  components: [
    {
      name: 'artifacts',
      type: 'tuple[]',
      components: [
        { name: 'digest', type: 'bytes32' },
        { name: 'registry', type: 'string' },
      ],
    },
    { name: 'upgradeByTime', type: 'uint32' },
  ],
};

const envVars = (name) => ({
  name,
  type: 'tuple[]',
  components: [
    { name: 'key', type: 'string' },
    { name: 'value', type: 'string' },
  ],
});

// AppController v1.5.x (sepolia-dev): Release gained a containerPolicy field.
export const APP_UPGRADED_V15 = {
  type: 'event',
  name: 'AppUpgraded',
  inputs: [
    { name: 'app', type: 'address', indexed: true },
    { name: 'rmsReleaseId', type: 'uint256', indexed: false },
    {
      name: 'release',
      type: 'tuple',
      indexed: false,
      components: [
        rmsRelease,
        { name: 'publicEnv', type: 'bytes' },
        { name: 'encryptedEnv', type: 'bytes' },
        {
          name: 'containerPolicy',
          type: 'tuple',
          components: [
            { name: 'args', type: 'string[]' },
            { name: 'cmdOverride', type: 'string[]' },
            envVars('env'),
            envVars('envOverride'),
            { name: 'restartPolicy', type: 'string' },
          ],
        },
      ],
    },
  ],
};

// AppController v1.4.x (sepolia prod, mainnet-alpha): 3-field Release.
export const APP_UPGRADED_V14 = {
  type: 'event',
  name: 'AppUpgraded',
  inputs: [
    { name: 'app', type: 'address', indexed: true },
    { name: 'rmsReleaseId', type: 'uint256', indexed: false },
    {
      name: 'release',
      type: 'tuple',
      indexed: false,
      components: [
        rmsRelease,
        { name: 'publicEnv', type: 'bytes' },
        { name: 'encryptedEnv', type: 'bytes' },
      ],
    },
  ],
};

// getAppLatestReleaseBlockNumber(address) — verified live against sepolia.
export const GET_LATEST_RELEASE_BLOCK_SELECTOR = '0x9ffbdce6';
