// Binary search operations for sorted price level arrays
export function findInsertIndex(prices, price, isDescending) {
  let low = 0;
  let high = prices.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const midPrice = prices[mid];

    if (midPrice === price) {
      return mid;
    }

    if (isDescending) {
      // Bids: descending order (higher price first)
      if (price > midPrice) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    } else {
      // Asks: ascending order (lower price first)
      if (price < midPrice) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
  }

  return low;
}

export function insertPrice(prices, price, isDescending) {
  const index = findInsertIndex(prices, price, isDescending);
  if (index < prices.length && prices[index] === price) {
    // Price level already exists in the sorted array
    return index;
  }
  prices.splice(index, 0, price);
  return index;
}

export function findPriceIndex(prices, price, isDescending) {
  let low = 0;
  let high = prices.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const midPrice = prices[mid];

    if (midPrice === price) {
      return mid;
    }

    if (isDescending) {
      if (price > midPrice) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    } else {
      if (price < midPrice) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
  }

  return -1;
}

export function removePrice(prices, price, isDescending) {
  const index = findPriceIndex(prices, price, isDescending);
  if (index === -1) {
    return -1;
  }
  prices.splice(index, 1);
  return index;
}

/**
 * Sorted Array Price Level Index using binary search over a plain native array.
 * Conforms to the PriceLevelIndex contract.
 */
export class SortedArrayPriceIndex {
  constructor(isDescending = false) {
    this.prices = [];
    this.isDescending = Boolean(isDescending);
  }

  get length() {
    return this.prices.length;
  }

  get 0() {
    return this.prices[0];
  }

  peek() {
    return this.prices.length > 0 ? this.prices[0] : undefined;
  }

  has(price) {
    return findPriceIndex(this.prices, price, this.isDescending) !== -1;
  }

  insert(price) {
    const prevLen = this.prices.length;
    insertPrice(this.prices, price, this.isDescending);
    return this.prices.length > prevLen;
  }

  remove(price) {
    return removePrice(this.prices, price, this.isDescending) !== -1;
  }

  toArray(limit) {
    return typeof limit === 'number' && limit > 0 ? this.prices.slice(0, limit) : [...this.prices];
  }

  *[Symbol.iterator]() {
    yield* this.prices;
  }
}
