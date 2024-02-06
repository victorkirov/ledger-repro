import * as ecc from "@bitcoinerlab/secp256k1";
import TransportHid from "@ledgerhq/hw-transport-node-hid";
import { base64 } from "@scure/base";
import * as btc from "@scure/btc-signer";
import { BIP32Factory } from "bip32";
import { AppClient, DefaultWalletPolicy, WalletPolicy } from "ledger-bitcoin";
const bip32 = BIP32Factory(ecc);
const nativeSegwitDerivationPath = "m/84'/1'/0'/0/0";
const transport = await TransportHid.default.create();
const app = new AppClient(transport);
const masterFingerPrint = await app.getMasterFingerprint();
const extendedPublicKey = await app.getExtendedPubkey("m/84'/1'/0'");
const nativeSegwitPolicy = new DefaultWalletPolicy("wpkh(@0/**)", `[${masterFingerPrint}/84'/1'/0']${extendedPublicKey}`);
const nativeSegwitAddress = await app.getWalletAddress(nativeSegwitPolicy, null, 0, 0, false);
const { publicKey: nativeSegwitPubKey } = bip32
    .fromBase58(extendedPublicKey, {
    bip32: {
        public: 0x043587cf,
        private: 0x04358394,
    },
    wif: 0xef,
} // testnet
)
    .derivePath("0/0");
const p2ms = btc.p2ms(1, [nativeSegwitPubKey]);
const p2sh = btc.p2sh(p2ms);
const multisigPolicy = new WalletPolicy("multisig", "sh(multi(1,@0/**))", [
    `[${masterFingerPrint}/84'/1'/0']${extendedPublicKey}`,
]);
const [_policyId, hmac] = await app.registerWallet(multisigPolicy);
const address = await app.getWalletAddress(multisigPolicy, hmac, 0, 0, false);
// get inputs
const inputs = await fetch(`https://mempool.space/testnet/api/address/${address}/utxo`).then((res) => res.json());
if (inputs.length === 0) {
    throw new Error(`No UTXOs found for address ${address}. Please send some funds to this address and try again.`);
}
const inputToSpend = inputs[0];
const inputTxnHex = await fetch(`https://mempool.space/testnet/api/tx/${inputToSpend.txid}/hex`).then((res) => res.text());
// build txn
const txn = new btc.Transaction();
txn.addInput({
    txid: inputToSpend.txid,
    index: inputToSpend.vout,
    nonWitnessUtxo: Buffer.from(inputTxnHex, "hex"),
    redeemScript: p2sh.redeemScript,
    witnessUtxo: {
        amount: BigInt(inputToSpend.value),
        script: p2sh.script,
    },
    bip32Derivation: [
        [
            nativeSegwitPubKey,
            {
                path: btc.bip32Path(nativeSegwitDerivationPath),
                fingerprint: parseInt(masterFingerPrint, 16),
            },
        ],
    ],
});
txn.addOutputAddress("2MvD5Ug9arybH1K4rJNDwiNaSCw9cPxfyZn", BigInt(inputToSpend.value - 500), btc.TEST_NETWORK);
const signed = await app.signPsbt(base64.encode(txn.toPSBT()), multisigPolicy, hmac);
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
