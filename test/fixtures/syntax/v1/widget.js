import { createBaseWidget } from "./base-widget.js";

export class CatalogWidget extends createBaseWidget() {
  constructor(label) {
    super();
    this.label = label;
  }

  render(item) {
    return `${this.label}: ${item.name}`;
  }
}

export function createWidget(label) {
  return new CatalogWidget(label);
}

export const renderWidget = (item) => item.name;
