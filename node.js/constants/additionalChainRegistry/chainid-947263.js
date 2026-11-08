module.exports = {
  name: "Betium",
  chain: "BETM",
  rpc: [
    "https://crypto.bullettsocial.space/rpc",
    "https://crypto.bullettsocial.space"
  ],
  faucets: [],
  nativeCurrency: {
    name: "Betium",
    symbol: "BETM",
    decimals: 18
  },
  features: [{ name: "EIP155" }, { name: "EIP1559" }],
  infoURL: "https://crypto.bullettsocial.space",
  shortName: "betm",
  chainId: 947263,
  networkId: 947263,
  icon: "betium",
  explorers: [{
    name: "Betium Explorer",
    url: "https://crypto.bullettsocial.space",
    icon: "betium",
    standard: "EIP3091"
  }]
};
