import TransportHid from "@ledgerhq/hw-transport-node-hid";
import { base64 } from "@scure/base";
import * as bip32 from "@scure/bip32";
import * as btc from "@scure/btc-signer";
import { AppClient, DefaultWalletPolicy, WalletPolicy } from "ledger-bitcoin";

function hexToBytes(hex: string) {
  let bytes = [];
  for (let c = 0; c < hex.length; c += 2)
    bytes.push(parseInt(hex.substr(c, 2), 16));
  return Uint8Array.from(bytes);
}

const nativeSegwitDerivationPath = "m/84'/1'/0'/0/0";
const transport = await TransportHid.default.create();
const app = new AppClient(transport);

const masterFingerPrint = await app.getMasterFingerprint();
const extendedPublicKey = await app.getExtendedPubkey("m/84'/1'/0'");

const nativeSegwitPolicy = new DefaultWalletPolicy(
  "wpkh(@0/**)",
  `[${masterFingerPrint}/84'/1'/0']${extendedPublicKey}`
);
const nativeSegwitAddress = await app.getWalletAddress(
  nativeSegwitPolicy,
  null,
  0,
  0,
  false
);

const testnet = {
  bip32: {
    public: 0x043587cf,
    private: 0x04358394,
  },
  wif: 0xef,
};

const { publicKey: nativeSegwitPubKey } = bip32.HDKey.fromExtendedKey(
  extendedPublicKey,
  testnet.bip32
)
  .deriveChild(0)
  .deriveChild(0);

const keySeed = hexToBytes("ab".repeat(32));
const localRootKey = bip32.HDKey.fromMasterSeed(
  Buffer.from(keySeed),
  testnet.bip32
);
const localSegwitKey = localRootKey.derive("m/84'/1'/0'");
const localKey = localSegwitKey.deriveChild(0).deriveChild(0);

const p2ms = btc.p2ms(2, [nativeSegwitPubKey!, localKey.publicKey!]);
const p2sh = btc.p2sh(p2ms, btc.TEST_NETWORK);

console.log("Address 1:", p2sh.address);

const multisigPolicy = new WalletPolicy(
  "multisig",
  "sh(multi(2,@0/**,@1/**))",
  [
    `[${masterFingerPrint}/84'/1'/0']${extendedPublicKey}`,
    localSegwitKey.publicExtendedKey,
  ]
);
const [_policyId, hmac] = await app.registerWallet(multisigPolicy);
const address = await app.getWalletAddress(multisigPolicy, hmac, 0, 0, false);

console.log("Address 2:", address);

// get inputs
const inputs = await fetch(
  `https://mempool.space/testnet/api/address/${address}/utxo`
).then((res) => res.json());

if (inputs.length === 0) {
  throw new Error(
    `No UTXOs found for address ${address}. Please send some funds to this address and try again.`
  );
}
const inputToSpend = inputs[0];
const inputTxnHex = await fetch(
  `https://mempool.space/testnet/api/tx/${inputToSpend.txid}/hex`
).then((res) => res.text());

// build txn
const txn = new btc.Transaction();
txn.addInput({
  txid: inputToSpend.txid,
  index: inputToSpend.vout,
  nonWitnessUtxo: Buffer.from(inputTxnHex, "hex"),
  redeemScript: p2sh.redeemScript,
  bip32Derivation: [
    [
      nativeSegwitPubKey!,
      {
        path: btc.bip32Path(nativeSegwitDerivationPath),
        fingerprint: parseInt(masterFingerPrint, 16),
      },
    ],
  ],
});

txn.addOutputAddress(
  "2MvD5Ug9arybH1K4rJNDwiNaSCw9cPxfyZn",
  BigInt(inputToSpend.value - 500),
  btc.TEST_NETWORK
);

const signed = await app.signPsbt(
  base64.encode(txn.toPSBT()),
  multisigPolicy,
  hmac
);

for (const signature of signed) {
  txn.updateInput(signature[0], {
    partialSig: [[signature[1].pubkey, signature[1].signature]],
  });
}

txn.finalize();
await fetch("https://mempool.space/testnet/api/tx", {
  method: "POST",
  body: txn.hex,
});
