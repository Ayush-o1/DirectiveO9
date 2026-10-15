/**
 * AVL Tree Node representation.
 */
class AvlNode {
  constructor(price) {
    this.price = price;
    this.height = 1;
    this.left = null;
    this.right = null;
  }
}

/**
 * Height-balanced AVL Tree Price Level Index.
 * Guarantees O(log N) insertion, deletion, and lookup with O(1) best price tracking.
 *
 * Implements the PriceLevelIndex contract:
 * - insert(price): boolean
 * - remove(price): boolean
 * - has(price): boolean
 * - peek(): number | undefined
 * - get 0(): number | undefined
 * - get length(): number
 * - toArray(limit): number[]
 * - [Symbol.iterator](): Generator<number>
 */
export class AvlTreePriceIndex {
  constructor(isDescending = false) {
    this.isDescending = isDescending;
    this.root = null;
    this.size = 0;
    this._min = undefined;
    this._max = undefined;
  }

  get length() {
    return this.size;
  }

  get 0() {
    return this.peek();
  }

  peek() {
    if (this.size === 0) return undefined;
    return this.isDescending ? this._max : this._min;
  }

  has(price) {
    let curr = this.root;
    while (curr !== null) {
      if (curr.price === price) return true;
      curr = price < curr.price ? curr.left : curr.right;
    }
    return false;
  }

  _height(node) {
    return node ? node.height : 0;
  }

  _updateHeight(node) {
    node.height = 1 + Math.max(this._height(node.left), this._height(node.right));
  }

  _getBalance(node) {
    return node ? this._height(node.left) - this._height(node.right) : 0;
  }

  _rotateRight(y) {
    const x = y.left;
    const t2 = x.right;

    x.right = y;
    y.left = t2;

    this._updateHeight(y);
    this._updateHeight(x);

    return x;
  }

  _rotateLeft(x) {
    const y = x.right;
    const t2 = y.left;

    y.left = x;
    x.right = t2;

    this._updateHeight(x);
    this._updateHeight(y);

    return y;
  }

  insert(price) {
    let inserted = false;

    const insertNode = node => {
      if (node === null) {
        inserted = true;
        return new AvlNode(price);
      }

      if (price === node.price) {
        return node; // Duplicate price level already exists
      }

      if (price < node.price) {
        node.left = insertNode(node.left);
      } else {
        node.right = insertNode(node.right);
      }

      this._updateHeight(node);
      const balance = this._getBalance(node);

      // Left-Left
      if (balance > 1 && price < node.left.price) {
        return this._rotateRight(node);
      }
      // Right-Right
      if (balance < -1 && price > node.right.price) {
        return this._rotateLeft(node);
      }
      // Left-Right
      if (balance > 1 && price > node.left.price) {
        node.left = this._rotateLeft(node.left);
        return this._rotateRight(node);
      }
      // Right-Left
      if (balance < -1 && price < node.right.price) {
        node.right = this._rotateRight(node.right);
        return this._rotateLeft(node);
      }

      return node;
    };

    this.root = insertNode(this.root);

    if (inserted) {
      this.size++;
      if (this._min === undefined || price < this._min) this._min = price;
      if (this._max === undefined || price > this._max) this._max = price;
    }

    return inserted;
  }

  _minValueNode(node) {
    let curr = node;
    while (curr.left !== null) {
      curr = curr.left;
    }
    return curr;
  }

  _maxValueNode(node) {
    let curr = node;
    while (curr.right !== null) {
      curr = curr.right;
    }
    return curr;
  }

  remove(price) {
    let removed = false;

    const deleteNode = (node, key) => {
      if (node === null) return null;

      if (key < node.price) {
        node.left = deleteNode(node.left, key);
      } else if (key > node.price) {
        node.right = deleteNode(node.right, key);
      } else {
        // Node found
        removed = true;

        if (node.left === null || node.right === null) {
          const temp = node.left ? node.left : node.right;
          if (temp === null) {
            node = null;
          } else {
            node = temp;
          }
        } else {
          // Node with two children: get inorder successor (smallest in right subtree)
          const temp = this._minValueNode(node.right);
          node.price = temp.price;
          node.right = deleteNode(node.right, temp.price);
        }
      }

      if (node === null) return null;

      this._updateHeight(node);
      const balance = this._getBalance(node);

      // Left-Left
      if (balance > 1 && this._getBalance(node.left) >= 0) {
        return this._rotateRight(node);
      }
      // Left-Right
      if (balance > 1 && this._getBalance(node.left) < 0) {
        node.left = this._rotateLeft(node.left);
        return this._rotateRight(node);
      }
      // Right-Right
      if (balance < -1 && this._getBalance(node.right) <= 0) {
        return this._rotateLeft(node);
      }
      // Right-Left
      if (balance < -1 && this._getBalance(node.right) > 0) {
        node.right = this._rotateRight(node.right);
        return this._rotateLeft(node);
      }

      return node;
    };

    this.root = deleteNode(this.root, price);

    if (removed) {
      this.size--;
      if (this.size === 0) {
        this._min = undefined;
        this._max = undefined;
      } else {
        if (price === this._min) {
          this._min = this._minValueNode(this.root).price;
        }
        if (price === this._max) {
          this._max = this._maxValueNode(this.root).price;
        }
      }
    }

    return removed;
  }

  *[Symbol.iterator]() {
    if (this.root === null) return;

    if (this.isDescending) {
      // Reverse in-order: right -> current -> left
      const stack = [];
      let curr = this.root;
      while (curr !== null || stack.length > 0) {
        while (curr !== null) {
          stack.push(curr);
          curr = curr.right;
        }
        curr = stack.pop();
        yield curr.price;
        curr = curr.left;
      }
    } else {
      // In-order: left -> current -> right
      const stack = [];
      let curr = this.root;
      while (curr !== null || stack.length > 0) {
        while (curr !== null) {
          stack.push(curr);
          curr = curr.left;
        }
        curr = stack.pop();
        yield curr.price;
        curr = curr.right;
      }
    }
  }

  toArray(limit) {
    const result = [];
    const maxItems = typeof limit === 'number' && limit > 0 ? limit : this.size;
    for (const p of this) {
      result.push(p);
      if (result.length >= maxItems) break;
    }
    return result;
  }
}
