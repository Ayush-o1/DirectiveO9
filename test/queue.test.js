import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OrderNode, LevelQueue } from '../src/engine/queue.js';

describe('LevelQueue (Doubly Linked FIFO)', () => {
  it('creates an empty level queue', () => {
    const queue = new LevelQueue(100);
    assert.equal(queue.price, 100);
    assert.equal(queue.total_volume, 0);
    assert.equal(queue.order_count, 0);
    assert.equal(queue.head, null);
    assert.equal(queue.tail, null);
    assert.equal(queue.isEmpty(), true);
  });

  it('appends orders in FIFO order and updates volume', () => {
    const queue = new LevelQueue(100);
    const node1 = new OrderNode({
      order_id: 1,
      participant_id: 10,
      price: 100,
      quantity: 5,
      seq: 1,
      ts: 1000,
    });
    const node2 = new OrderNode({
      order_id: 2,
      participant_id: 11,
      price: 100,
      quantity: 12,
      seq: 2,
      ts: 1001,
    });

    queue.append(node1);
    assert.equal(queue.order_count, 1);
    assert.equal(queue.total_volume, 5);
    assert.equal(queue.head, node1);
    assert.equal(queue.tail, node1);

    queue.append(node2);
    assert.equal(queue.order_count, 2);
    assert.equal(queue.total_volume, 17);
    assert.equal(queue.head, node1);
    assert.equal(queue.tail, node2);
    assert.equal(node1.next, node2);
    assert.equal(node2.prev, node1);
  });

  it('removes head order correctly', () => {
    const queue = new LevelQueue(100);
    const node1 = new OrderNode({
      order_id: 1,
      participant_id: 10,
      price: 100,
      quantity: 5,
      seq: 1,
      ts: 1000,
    });
    const node2 = new OrderNode({
      order_id: 2,
      participant_id: 11,
      price: 100,
      quantity: 10,
      seq: 2,
      ts: 1001,
    });

    queue.append(node1);
    queue.append(node2);

    queue.remove(node1);
    assert.equal(queue.order_count, 1);
    assert.equal(queue.total_volume, 10);
    assert.equal(queue.head, node2);
    assert.equal(queue.tail, node2);
    assert.equal(node2.prev, null);
    assert.equal(node1.prev, null);
    assert.equal(node1.next, null);
  });

  it('removes tail order correctly', () => {
    const queue = new LevelQueue(100);
    const node1 = new OrderNode({
      order_id: 1,
      participant_id: 10,
      price: 100,
      quantity: 5,
      seq: 1,
      ts: 1000,
    });
    const node2 = new OrderNode({
      order_id: 2,
      participant_id: 11,
      price: 100,
      quantity: 10,
      seq: 2,
      ts: 1001,
    });

    queue.append(node1);
    queue.append(node2);

    queue.remove(node2);
    assert.equal(queue.order_count, 1);
    assert.equal(queue.total_volume, 5);
    assert.equal(queue.head, node1);
    assert.equal(queue.tail, node1);
    assert.equal(node1.next, null);
  });

  it('removes middle order correctly', () => {
    const queue = new LevelQueue(100);
    const node1 = new OrderNode({
      order_id: 1,
      participant_id: 10,
      price: 100,
      quantity: 5,
      seq: 1,
      ts: 1000,
    });
    const node2 = new OrderNode({
      order_id: 2,
      participant_id: 11,
      price: 100,
      quantity: 10,
      seq: 2,
      ts: 1001,
    });
    const node3 = new OrderNode({
      order_id: 3,
      participant_id: 12,
      price: 100,
      quantity: 15,
      seq: 3,
      ts: 1002,
    });

    queue.append(node1);
    queue.append(node2);
    queue.append(node3);

    queue.remove(node2);
    assert.equal(queue.order_count, 2);
    assert.equal(queue.total_volume, 20);
    assert.equal(queue.head, node1);
    assert.equal(queue.tail, node3);
    assert.equal(node1.next, node3);
    assert.equal(node3.prev, node1);
  });

  it('handles removal of sole node becoming empty', () => {
    const queue = new LevelQueue(100);
    const node = new OrderNode({
      order_id: 1,
      participant_id: 10,
      price: 100,
      quantity: 5,
      seq: 1,
      ts: 1000,
    });

    queue.append(node);
    queue.remove(node);

    assert.equal(queue.order_count, 0);
    assert.equal(queue.total_volume, 0);
    assert.equal(queue.head, null);
    assert.equal(queue.tail, null);
    assert.equal(queue.isEmpty(), true);
  });
});
