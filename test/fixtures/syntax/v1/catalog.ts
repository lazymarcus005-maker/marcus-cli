import { BaseCatalog } from "./base-catalog.js";

export namespace Inventory {
  export type ItemKey = string;

  export enum ItemState {
    Ready = "ready",
    Retired = "retired",
  }

  export interface CatalogItem {
    readonly key: ItemKey;
    state: ItemState;
  }

  export class CatalogStore extends BaseCatalog {
    readonly items: CatalogItem[];

    constructor(items: CatalogItem[]) {
      super();
      this.items = items;
    }

    find(key: ItemKey): CatalogItem | undefined {
      return this.items.find((item) => item.key === key);
    }
  }

  export function createStore(items: CatalogItem[]): CatalogStore {
    return new CatalogStore(items);
  }
}

export default Inventory.CatalogStore;
