import * as Bip39 from "bip39";
import * as Bip32 from "bip32";
import * as TaquitoUtils from "@taquito/utils";
import { InMemorySigner } from "@taquito/signer";
import * as Passworder from "lib/thanos/passworder";
import { ThanosAccount, ThanosAccountType } from "lib/thanos/types";
import {
  isStored,
  fetchAndDecryptOne,
  encryptAndSaveMany
} from "lib/thanos/back/safe-storage";

const TEZOS_BIP44_COINTYPE = 1729;
const STORAGE_KEY_PREFIX = "vault";

enum StorageEntity {
  Check = "check",
  Mnemonic = "mnemonic",
  AccPrivKey = "accprivkey",
  AccPubKey = "accpubkey",
  Accounts = "accounts"
}

const checkStrgKey = createStorageKey(StorageEntity.Check);
const mnemonicStrgKey = createStorageKey(StorageEntity.Mnemonic);
const accPrivKeyStrgKey = createDynamicStorageKey(StorageEntity.AccPrivKey);
const accPubKeyStrgKey = createDynamicStorageKey(StorageEntity.AccPubKey);
const accountsStrgKey = createStorageKey(StorageEntity.Accounts);

export class Vault {
  static isExist() {
    return isStored(checkStrgKey);
  }

  static async setup(password: string) {
    const passKey = await Vault.toValidPassKey(password);
    return withError("Failed to unlock wallet", async () => {
      await fetchAndDecryptOne(checkStrgKey, passKey);
      return new Vault(passKey);
    });
  }

  static async spawn(password: string, mnemonic?: string) {
    return withError("Failed to create wallet", async () => {
      if (!mnemonic) {
        mnemonic = Bip39.generateMnemonic(128);
      }
      const seed = Bip39.mnemonicToSeedSync(mnemonic);

      const hdAccIndex = 0;
      const accPrivateKey = seedToHDPrivateKey(seed, hdAccIndex);
      const [accPublicKey, accPublicKeyHash] = await getPublicKeyAndHash(
        accPrivateKey
      );

      const initialAccount: ThanosAccount = {
        type: ThanosAccountType.HD,
        name: "Account 1",
        publicKeyHash: accPublicKeyHash
      };
      const newAccounts = [initialAccount];

      const passKey = await Passworder.generateKey(password);

      await encryptAndSaveMany(
        [
          [checkStrgKey, null],
          [mnemonicStrgKey, mnemonic],
          [accPrivKeyStrgKey(accPublicKeyHash), accPrivateKey],
          [accPubKeyStrgKey(accPublicKeyHash), accPublicKey],
          [accountsStrgKey, newAccounts]
        ],
        passKey
      );
    });
  }

  static async revealMnemonic(password: string) {
    const passKey = await Vault.toValidPassKey(password);
    return withError("Failed to reveal seed phrase", () =>
      fetchAndDecryptOne<string>(mnemonicStrgKey, passKey)
    );
  }

  static async revealPrivateKey(accPublicKeyHash: string, password: string) {
    const passKey = await Vault.toValidPassKey(password);
    return withError("Failed to reveal private key", () =>
      fetchAndDecryptOne<string>(accPrivKeyStrgKey(accPublicKeyHash), passKey)
    );
  }
  static async createHDAccount(password: string) {
    const passKey = await Vault.toValidPassKey(password);
    return withError("Failed to create account", async () => {
      const [mnemonic, allAccounts] = await Promise.all([
        fetchAndDecryptOne<string>(mnemonicStrgKey, passKey),
        fetchAndDecryptOne<ThanosAccount[]>(accountsStrgKey, passKey)
      ]);

      const seed = Bip39.mnemonicToSeedSync(mnemonic);
      const allHDAccounts = allAccounts.filter(
        a => a.type === ThanosAccountType.HD
      );
      const hdAccIndex = allHDAccounts.length;
      const accPrivateKey = seedToHDPrivateKey(seed, hdAccIndex);
      const [accPublicKey, accPublicKeyHash] = await getPublicKeyAndHash(
        accPrivateKey
      );

      const newAccount: ThanosAccount = {
        type: ThanosAccountType.HD,
        name: getNewAccountName(allAccounts),
        publicKeyHash: accPublicKeyHash
      };
      const newAllAcounts = concatAccount(allAccounts, newAccount);

      await encryptAndSaveMany(
        [
          [accPrivKeyStrgKey(accPublicKeyHash), accPrivateKey],
          [accPubKeyStrgKey(accPublicKeyHash), accPublicKey],
          [accountsStrgKey, newAllAcounts]
        ],
        passKey
      );

      return newAllAcounts;
    });
  }

  private static toValidPassKey(password: string) {
    return withError("Invalid password", async doThrow => {
      const passKey = await Passworder.generateKey(password);
      const check = await fetchAndDecryptOne<any>(checkStrgKey, passKey);
      if (check !== null) {
        doThrow();
      }
      return passKey;
    });
  }

  constructor(private passKey: CryptoKey) {}

  revealPublicKey(accPublicKeyHash: string) {
    return withError("Failed to reveal public key", () =>
      fetchAndDecryptOne<string>(
        accPubKeyStrgKey(accPublicKeyHash),
        this.passKey
      )
    );
  }

  fetchAccounts() {
    return fetchAndDecryptOne<ThanosAccount[]>(accountsStrgKey, this.passKey);
  }

  async importAccount(accPrivateKey: string) {
    const errMessage =
      "Failed to import account" +
      ".\nThis may happen because provided Key is invalid";

    return withError(errMessage, async () => {
      const allAccounts = await this.fetchAccounts();

      const [accPublicKey, accPublicKeyHash] = await getPublicKeyAndHash(
        accPrivateKey
      );

      const newAccount: ThanosAccount = {
        type: ThanosAccountType.Imported,
        name: getNewAccountName(allAccounts),
        publicKeyHash: accPublicKeyHash
      };
      const newAllAcounts = concatAccount(allAccounts, newAccount);

      await encryptAndSaveMany(
        [
          [accPrivKeyStrgKey(accPublicKeyHash), accPrivateKey],
          [accPubKeyStrgKey(accPublicKeyHash), accPublicKey],
          [accountsStrgKey, newAllAcounts]
        ],
        this.passKey
      );

      return newAllAcounts;
    });
  }

  async importFundraiserAccount(
    email: string,
    password: string,
    mnemonic: string
  ) {
    return withError("Failed to import fundraiser account", async () => {
      const seed = Bip39.mnemonicToSeedSync(mnemonic, `${email}${password}`);
      const privateKey = TaquitoUtils.b58cencode(
        seed.slice(0, 32),
        TaquitoUtils.prefix.edsk2
      );

      return this.importAccount(privateKey);
    });
  }

  async editAccountName(accPublicKeyHash: string, name: string) {
    return withError("Failed to edit account name", async () => {
      const allAccounts = await this.fetchAccounts();
      if (!allAccounts.some(acc => acc.publicKeyHash === accPublicKeyHash)) {
        throw new PublicError("Account not found");
      }

      if (
        allAccounts.some(
          acc => acc.publicKeyHash !== accPublicKeyHash && acc.name === name
        )
      ) {
        throw new PublicError("Account with same name already exist");
      }

      const newAllAcounts = allAccounts.map(acc =>
        acc.publicKeyHash === accPublicKeyHash ? { ...acc, name } : acc
      );
      await encryptAndSaveMany(
        [[accountsStrgKey, newAllAcounts]],
        this.passKey
      );

      return newAllAcounts;
    });
  }

  async sign(accPublicKeyHash: string, bytes: string, watermark?: string) {
    return withError("Failed to sign", async () => {
      const privateKey = await fetchAndDecryptOne<string>(
        accPrivKeyStrgKey(accPublicKeyHash),
        this.passKey
      );
      const signer = await createMemorySigner(privateKey);
      const watermarkBuf =
        watermark && (TaquitoUtils.hex2buf(watermark) as any);
      return signer.sign(bytes, watermarkBuf);
    });
  }
}

function concatAccount(current: ThanosAccount[], newOne: ThanosAccount) {
  if (current.every(a => a.publicKeyHash !== newOne.publicKeyHash)) {
    return [...current, newOne];
  }

  throw new PublicError("Account already exists");
}

function getNewAccountName(allAccounts: ThanosAccount[]) {
  return `Account ${allAccounts.length + 1}`;
}

async function getPublicKeyAndHash(privateKey: string) {
  const signer = await createMemorySigner(privateKey);
  return Promise.all([signer.publicKey(), signer.publicKeyHash()]);
}

async function createMemorySigner(privateKey: string) {
  return InMemorySigner.fromSecretKey(privateKey);
}

function seedToHDPrivateKey(seed: Buffer, hdAccIndex: number) {
  const keyNode = Bip32.fromSeed(seed);
  const keyChild = keyNode.derivePath(
    `m/44'/${TEZOS_BIP44_COINTYPE}'/${hdAccIndex}'/0/0`
  );

  return TaquitoUtils.b58cencode(
    keyChild.privateKey!.slice(0, 32),
    TaquitoUtils.prefix.edsk2
  );
}

function createStorageKey(id: StorageEntity) {
  return combineStorageKey(STORAGE_KEY_PREFIX, id);
}

function createDynamicStorageKey(id: StorageEntity) {
  const keyBase = combineStorageKey(STORAGE_KEY_PREFIX, id);
  return (subKey: number | string) => combineStorageKey(keyBase, subKey);
}

function combineStorageKey(...parts: (string | number)[]) {
  return parts.join("_");
}

async function withError<T>(
  errMessage: string,
  factory: (doThrow: () => void) => Promise<T>
) {
  try {
    return await factory(() => {
      throw new Error("<stub>");
    });
  } catch (err) {
    throw err instanceof PublicError ? err : new Error(errMessage);
  }
}

class PublicError extends Error {}
