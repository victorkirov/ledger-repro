import TransportHid from "@ledgerhq/hw-transport-node-hid";
import { base64 } from "@scure/base";
import * as bip32 from "@scure/bip32";
import * as btc from "@scure/btc-signer";
import { AppClient, WalletPolicy } from "ledger-bitcoin";

const changeAddress = "2MvD5Ug9arybH1K4rJNDwiNaSCw9cPxfyZn";
const ledgerAccountIdx = 0;
const localAccountIdx = 0;

function hexToBytes(hex: string) {
  let bytes = [];
  for (let c = 0; c < hex.length; c += 2)
    bytes.push(parseInt(hex.substr(c, 2), 16));
  return Uint8Array.from(bytes);
}

const testnet = {
  bip32: {
    public: 0x043587cf,
    private: 0x04358394,
  },
  wif: 0xef,
};

const transport = await TransportHid.default.create();
const app = new AppClient(transport);

const getLedgerStuff = async (accountIdx: 0 | 1) => {
  const masterFingerPrint = await app.getMasterFingerprint();
  const extendedPublicKey = await app.getExtendedPubkey("m/84'/1'/0'");

  const { publicKey: nativeSegwitPubKey } = bip32.HDKey.fromExtendedKey(
    extendedPublicKey,
    testnet.bip32
  )
    .deriveChild(0)
    .deriveChild(accountIdx);

  return {
    masterFingerPrint,
    extendedPublicKey,
    nativeSegwitPubKey: nativeSegwitPubKey!,
    derivationPath: `m/84'/1'/0'/0/${accountIdx}`,
  };
};

const getLocalStuff = async (accountIdx: 0 | 1) => {
  const keySeed = hexToBytes("ab".repeat(32));
  const localRootKey = bip32.HDKey.fromMasterSeed(
    Buffer.from(keySeed),
    testnet.bip32
  );
  const masterFingerPrint = localRootKey.fingerprint.toString(16);
  const localSegwitKey = localRootKey.derive("m/84'/1'/0'");
  const localKey = localSegwitKey.deriveChild(0).deriveChild(accountIdx);

  return {
    masterFingerPrint,
    extendedPublicKey: localSegwitKey.publicExtendedKey!,
    nativeSegwitPubKey: localKey.publicKey!,
    nativeSegwitPrivKey: localKey.privateKey!,
    derivationPath: `m/84'/1'/0'/0/${accountIdx}`,
  };
};

const run = async () => {
  const ledgerStuff = await getLedgerStuff(ledgerAccountIdx);
  const localStuff = await getLocalStuff(localAccountIdx);

  // build multisig wrapped in script hash address
  const p2ms = btc.p2ms(2, [
    ledgerStuff.nativeSegwitPubKey,
    localStuff.nativeSegwitPubKey,
  ]);
  const p2sh = btc.p2sh(p2ms, btc.TEST_NETWORK);

  const address = p2sh.address;

  console.log("Multisig address:", address);

  // get inputs for address
  const inputs = await fetch(
    `https://mempool.space/testnet/api/address/${address}/utxo`
  ).then((res) => res.json());

  if (inputs.length === 0) {
    throw new Error(
      `No UTXOs found for address ${address}. Please send at least 2000 sats to this address and try again.`
    );
  }
  const inputToSpend = inputs[0];

  const inputTxnHex = await fetch(
    `https://mempool.space/testnet/api/tx/${inputToSpend.txid}/hex`
  ).then((res) => res.text());

  // register multisig wallet
  const multisigPolicy = new WalletPolicy(
    "multisig",
    "sh(multi(2,@0/**,@1/**))",
    [
      `[${ledgerStuff.masterFingerPrint}/84'/1'/0']${ledgerStuff.extendedPublicKey}`,
      `[${localStuff.masterFingerPrint}/84'/1'/0']${localStuff.extendedPublicKey}`,
    ]
  );
  const [_policyId, hmac] = await app.registerWallet(multisigPolicy);

  // build txn
  const txn = new btc.Transaction();
  txn.addInput({
    txid: inputToSpend.txid,
    index: inputToSpend.vout,
    nonWitnessUtxo: Buffer.from(inputTxnHex, "hex"),
    redeemScript: p2sh.redeemScript,
    bip32Derivation: [
      [
        ledgerStuff.nativeSegwitPubKey,
        {
          path: btc.bip32Path(ledgerStuff.derivationPath),
          fingerprint: parseInt(ledgerStuff.masterFingerPrint, 16),
        },
      ],
      [
        localStuff.nativeSegwitPubKey,
        {
          path: btc.bip32Path(localStuff.derivationPath),
          fingerprint: parseInt(localStuff.masterFingerPrint, 16),
        },
      ],
    ],
  });

  txn.addOutputAddress(
    changeAddress,
    BigInt(inputToSpend.value - 500),
    btc.TEST_NETWORK
  );

  // ledger is first multisig signer, so sign with it first
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

  // sign with local key second
  txn.signIdx(localStuff.nativeSegwitPrivKey, 0);

  // finalise and broadcast
  txn.finalize();

  await fetch("https://mempool.space/testnet/api/tx", {
    method: "POST",
    body: txn.hex,
  });

  console.log("See txn at: https://mempool.space/testnet/tx/" + txn.id);
};

run().catch(console.error);
