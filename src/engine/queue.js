// Doubly linked FIFO queue for orders at a single price level
export class OrderNode {
  constructor({ order_id, participant_id, price, quantity, seq, ts }) {
    this.order_id = order_id;
    this.participant_id = participant_id;
    this.price = price;
    this.quantity = quantity;
    this.remaining_qty = quantity;
    this.seq = seq;
    this.ts = ts;
    this.prev = null;
    this.next = null;
  }
}

export class LevelQueue {
  constructor(price) {
    this.price = price;
    this.total_volume = 0;
    this.order_count = 0;
    this.head = null;
    this.tail = null;
  }

  append(node) {
    if (this.tail === null) {
      this.head = node;
      this.tail = node;
      node.prev = null;
      node.next = null;
    } else {
      this.tail.next = node;
      node.prev = this.tail;
      node.next = null;
      this.tail = node;
    }

    this.total_volume += node.remaining_qty;
    this.order_count += 1;
    return node;
  }

  remove(node) {
    if (node.prev !== null) {
      node.prev.next = node.next;
    } else {
      // Removing the head
      this.head = node.next;
    }

    if (node.next !== null) {
      node.next.prev = node.prev;
    } else {
      // Removing the tail
      this.tail = node.prev;
    }

    node.prev = null;
    node.next = null;

    this.total_volume -= node.remaining_qty;
    this.order_count -= 1;
    return node;
  }

  isEmpty() {
    return this.order_count === 0;
  }
}
