import type { IPFS } from "ipfs-core-types";
import { CeramicApi, SyncOptions } from "@ceramicnetwork/common";
import { ConfigOptions, ParcelOptions } from "../index";
import { CID } from "multiformats";
import { TileDocument } from "@ceramicnetwork/stream-tile";
import { schema } from "@geo-web/types";
import * as json from "multiformats/codecs/json";
import * as dagjson from "@ipld/dag-json";
import * as Block from "multiformats/block";
import { sha256 as hasher } from "multiformats/hashes/sha2";
import * as dagcbor from "@ipld/dag-cbor";
import { default as axios } from "axios";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import type { InvocationConfig } from "@web3-storage/upload-client";
import { CAR, uploadCAR } from "@web3-storage/upload-client";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { create } from "@ipld/schema/typed.js";

type SchemaOptions = {
  schema?: string;
};

type LeafSchemaOptions = {
  parentSchema?: string;
  leafSchema?: string;
};

type PinOptions = {
  pin?: boolean;
};

export class API {
  #ipfs: IPFS;
  #ipfsGatewayHost?: string;
  #ceramic: CeramicApi;
  #w3InvocationConfig?: InvocationConfig;

  constructor(opts: ConfigOptions) {
    this.#ipfs = opts.ipfs;
    this.#ipfsGatewayHost = opts.ipfsGatewayHost;
    this.#ceramic = opts.ceramic;
    this.#w3InvocationConfig = opts.w3InvocationConfig;
  }

  /*
   * Initialize empty content root
   */
  async initRoot(opts: ParcelOptions): Promise<void> {
    const emptyRoot = await this.#ipfs.dag.put({}, { storeCodec: "dag-cbor" });
    return await this.commit(emptyRoot, opts);
  }

  /*
   * Resolve content root
   *
   * Fallbacks:
   * 1. Check TileDocument with EIP-55 checksum address
   * 2. Check TileDocument with lowercase address
   * 3. Empty root
   */
  async resolveRoot(opts: ParcelOptions): Promise<CID> {
    // 1. EIP-55 checksum address
    let doc = await TileDocument.deterministic<Record<string, any>>(
      this.#ceramic,
      {
        controllers: [opts.ownerDID],
        family: `geo-web-parcel`,
        tags: [opts.parcelId.toString()],
      },
      { sync: SyncOptions.SYNC_ALWAYS }
    );

    if (!doc.content["/"]) {
      // 2. Lowercase address
      doc = await TileDocument.deterministic<Record<string, any>>(
        this.#ceramic,
        {
          controllers: [opts.ownerDID.toLowerCase()],
          family: `geo-web-parcel`,
          tags: [opts.parcelId.toString()],
        },
        { sync: SyncOptions.SYNC_ALWAYS }
      );
    }

    if (doc.content["/"]) {
      return CID.parse(doc.content["/"]);
    } else {
      // Empty root
      const emptyRoot = await this.#ipfs.dag.put(
        {},
        { storeCodec: "dag-cbor" }
      );
      return emptyRoot;
    }
  }

  /*
   * Retrieves IPLD object at path from any root
   *  - Validates schema + transforms representation -> typed before read
   */
  async get(root: CID, path: string, opts: SchemaOptions): Promise<any> {
    let value: any;
    try {
      const result = await this.#ipfs.dag.get(root, { path, timeout: 2000 });
      value = result.value;
    } catch (e) {
      if (this.#ipfsGatewayHost) {
        try {
          // Download raw block
          console.debug(
            `Retrieving raw block from: ${
              this.#ipfsGatewayHost
            }/ipfs/${root.toString()}/${path}`
          );
          const rawBlock = await axios.get(
            `${this.#ipfsGatewayHost}/ipfs/${root.toString()}/${path}`,
            {
              responseType: "arraybuffer",
              headers: { Accept: "application/vnd.ipld.raw" },
            }
          );
          const uintBuffer = new Uint8Array(rawBlock.data);
          const block = await Block.decode({
            bytes: uintBuffer,
            codec: dagcbor,
            hasher,
          });

          this.#ipfs.block.put(uintBuffer);

          value = block.value;
        } catch (e) {
          console.warn(`Could not retrieve raw block: ` + e);
        }
      } else {
        console.info(`Skipping gateway lookup. ipfsGatewayHost not found`);
      }
    }

    if (opts.schema) {
      const schemaTyped = create(schema, opts.schema);
      return schemaTyped.toTyped(value);
    } else {
      return value;
    }
  }

  /*
   * Retrieves IPLD object at path from parcel root
   *  - Validates schema + transforms representation -> typed before read
   */
  async getPath(
    path: string,
    opts: ParcelOptions & SchemaOptions
  ): Promise<any> {
    const root = await this.resolveRoot(opts);

    return await this.get(root, path, opts);
  }

  /*
   * Update node at path and recursively update all parents from the leaf to the root.
   *  - Returns new root
   *  - Validates schema + transforms typed -> representation before write
   */
  async putPath(
    root: CID,
    path: string,
    data: any,
    opts?: LeafSchemaOptions & PinOptions
  ): Promise<CID> {
    let newData = data;
    if (opts?.leafSchema) {
      const schemaTyped = create(schema, opts.leafSchema);
      newData = schemaTyped.toRepresentation(data);
      if (newData === undefined) {
        throw new TypeError("Invalid data form, does not match leafSchema");
      }
    }

    // 1. Replace CID at first parent
    const pathSegments = path.split("/");
    const lastPathSegment = pathSegments[pathSegments.length - 1];
    let parentPath = path.replace(`/${lastPathSegment}`, "");
    const { cid, remainderPath } = await this.#ipfs.dag.resolve(
      `/ipfs/${root.toString()}${parentPath}`
    );
    const { value } = await this.#ipfs.dag.get(cid);

    function putInnerPath(node: any, path: string, data: any): any {
      const pathSegments = path.split("/");

      // Base case, no path or root
      if (pathSegments.length === 2 && pathSegments[1] === "") {
        return node;
      }
      // Base case, one path left
      if (pathSegments.length === 1) {
        if (data == null) {
          delete node[pathSegments[0]];
        } else {
          node[pathSegments[0]] = data;
        }
        return node;
      }
      // Base case, one path left with /
      if (pathSegments.length === 2) {
        if (data == null) {
          delete node[pathSegments[1]];
        } else {
          node[pathSegments[1]] = data;
        }
        return node;
      }

      // Put on nested object
      node[pathSegments[1]] = putInnerPath(
        node[pathSegments[1]],
        pathSegments.slice(2).join("/"),
        data
      );
      return node;
    }

    const innerBlocks = [];
    let newValue;
    if (remainderPath === "" || remainderPath === undefined) {
      // Replace leaf
      newValue = putInnerPath(value, `/${lastPathSegment}`, newData);
      // Filter undefined from arrays
      if (Array.isArray(newValue)) {
        newValue = newValue.filter((v) => v);
      }
      if (opts?.parentSchema) {
        const schemaTyped = create(schema, opts.parentSchema);
        let newDataRepresentation = schemaTyped.toRepresentation(newValue);
        if (newValue && newDataRepresentation === undefined) {
          // Try again with a Link
          const newDataLink = await this.#ipfs.dag.put(newData, {
            storeCodec: "dag-cbor",
          });
          const block = await Block.encode({
            value: newData,
            codec: dagcbor,
            hasher,
          });
          innerBlocks.push(block);
          newValue = putInnerPath(value, `/${lastPathSegment}`, newDataLink);
          newDataRepresentation = schemaTyped.toRepresentation(newValue);
          if (newDataRepresentation === undefined) {
            throw new TypeError(
              "Invalid data form, does not match parentSchema"
            );
          }
        }
      }
    } else {
      // Replace nested leaf
      const nestedPath = `/${remainderPath}/${lastPathSegment}`;
      newValue = putInnerPath(value, nestedPath, newData);
      // Filter undefined from arrays
      if (Array.isArray(newValue)) {
        newValue = newValue.filter((v) => v);
      }
      if (opts?.parentSchema) {
        const schemaTyped = create(schema, opts.parentSchema);
        let newDataRepresentation = schemaTyped.toRepresentation(newValue);
        if (newValue && newDataRepresentation === undefined) {
          // Try again with a Link
          const newDataLink = await this.#ipfs.dag.put(newData, {
            storeCodec: "dag-cbor",
          });
          const block = await Block.encode({
            value: newData,
            codec: dagcbor,
            hasher,
          });
          innerBlocks.push(block);
          newValue = putInnerPath(value, nestedPath, newDataLink);
          newDataRepresentation = schemaTyped.toRepresentation(newValue);
          if (newDataRepresentation === undefined) {
            throw new TypeError(
              "Invalid data form, does not match parentSchema"
            );
          }
        }
      }

      parentPath = parentPath.replace(remainderPath, "");
    }

    const newCid = await this.#ipfs.dag.put(newValue, {
      storeCodec: "dag-cbor",
    });

    if (opts?.pin) {
      if (!this.#w3InvocationConfig) {
        throw new Error("Web3Storage not configured");
      }

      // Build CAR
      const block = await Block.encode({
        value: newValue,
        codec: dagcbor,
        hasher,
      });

      try {
        const car = await CAR.encode([block, ...innerBlocks]);
        await uploadCAR(this.#w3InvocationConfig, car);
      } catch (e) {
        console.error(e);
        throw e;
      }
    }

    // 2a. Base case, path is root
    if (parentPath === "/" || parentPath === "") {
      return newCid;
    }

    // 2b. Replace parent CID recursively
    return this.putPath(root, parentPath, newCid, { pin: opts?.pin });
  }

  /*
   * Delete node at path and recursively update all parents from the leaf to the root.
   *  - Returns new root
   */
  async deletePath(
    root: CID,
    path: string,
    opts?: LeafSchemaOptions & PinOptions
  ): Promise<CID> {
    return await this.putPath(root, path, null, opts);
  }

  /*
   * Commit new root to Ceramic
   */
  async commit(root: CID, opts: ParcelOptions): Promise<void> {
    const doc = await TileDocument.deterministic<Record<string, any>>(
      this.#ceramic,
      {
        controllers: [opts.ownerDID],
        family: `geo-web-parcel`,
        tags: [opts.parcelId.toString()],
      },
      { sync: SyncOptions.SYNC_ALWAYS }
    );

    // Commit to TileDocument
    const bytes = dagjson.encode(root);
    await doc.update(json.decode(bytes));
  }
}
