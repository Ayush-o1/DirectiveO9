# DirectiveO9 API Specification

DirectiveO9 provides an HTTP REST API and Server-Sent Events (SSE) stream for interacting with the matching engine, querying market data, and performing operational audits.

All endpoints accept and return JSON payloads. Quantities and prices in payloads are integer ticks and integer lots.

---

## Authentication & Headers

Requests that mutate order state (`POST /orders`, `DELETE /orders/:id`) require authentication:

- `X-Participant-Id`: Participant identifier (integer or UUID).
- `X-API-Key`: Secret API key matching the participant's registered credential.

---

## Endpoints

### 1. Submit Order

- **Method**: `POST`
- **Path**: `/orders`
- **Request Body**:
  ```json
  {
    "client_order_id": "c-10042",
    "symbol": "BTC-USDT",
    "side": "BUY",
    "type": "LIMIT",
    "price": 6500000,
    "quantity": 10
  }
  ```
- **Responses**:
  - `201 Created`: Order accepted or partially filled and resting.
  - `200 OK`: Order aggressively filled immediately (terminal `FILLED`), or idempotent return of an existing submission.
  - `400 Bad Request`: Validation failure (enumerated reject code).
  - `401 Unauthorized`: Missing or invalid participant credentials.
  - `429 Too Many Requests`: Sequencer queue capacity exceeded (`QUEUE_FULL`).

---

### 2. Cancel Order

- **Method**: `DELETE`
- **Path**: `/orders/:id`
- **Request Parameters**:
  - `id`: Order ID assigned during acceptance.
- **Request Body**:
  ```json
  {
    "client_order_id": "c-cancel-10043",
    "symbol": "BTC-USDT"
  }
  ```
- **Responses**:
  - `200 OK`: Order unlinked and cancelled.
  - `400 Bad Request`: Target order does not exist (`UNKNOWN_ORDER`) or already terminal (`ALREADY_TERMINAL`).
  - `403 Forbidden`: Requesting participant is not the order owner (`NOT_OWNER`).

---

### 3. Get Order by ID

- **Method**: `GET`
- **Path**: `/orders/:id`
- **Responses**:
  - `200 OK`: Order projection details.
  - `404 Not Found`: Order ID unknown.

---

### 4. Get Order Book Depth (L2)

- **Method**: `GET`
- **Path**: `/book/:symbol?depth=20`
- **Query Parameters**:
  - `depth`: Number of price levels to return (default: 50, maximum: 500).
- **Response**:
  ```json
  {
    "symbol": "BTC-USDT",
    "seq": 10842,
    "bids": [{ "price": 6500000, "quantity": 45, "order_count": 3 }],
    "asks": [{ "price": 6500100, "quantity": 12, "order_count": 1 }]
  }
  ```

---

### 5. Get Trade History

- **Method**: `GET`
- **Path**: `/trades?symbol=BTC-USDT&from_seq=1000`
- **Query Parameters**:
  - `symbol`: Instrument identifier.
  - `from_seq`: Minimum sequence number (optional).
  - `limit`: Maximum records to return (default: 100).
- **Response**:
  ```json
  [
    {
      "trade_id": 402,
      "seq": 10842,
      "symbol": "BTC-USDT",
      "price": 6500000,
      "quantity": 5,
      "maker_order_id": 1002,
      "taker_order_id": 1005,
      "taker_side": "SELL",
      "ts": "1729000000000000"
    }
  ]
  ```

---

### 6. Get Raw Event Log

- **Method**: `GET`
- **Path**: `/events?from_seq=0&limit=100`
- **Query Parameters**:
  - `from_seq`: Starting sequence number.
  - `limit`: Batch limit.
- **Response**: Array of discrete matching engine events in chronological order.

---

### 7. Administrative Replay

- **Method**: `POST`
- **Path**: `/admin/replay`
- **Request Body**:
  ```json
  {
    "target_seq": 10842
  }
  ```
- **Response**:
  ```json
  {
    "status": "VERIFIED",
    "commands_replayed": 1000,
    "expected_hash": "<canonical_sha256_hex>",
    "actual_hash": "<canonical_sha256_hex>",
    "invariants_passed": true,
    "duration_ms": "<elapsed_ms>"
  }
  ```

---

### 8. Administrative Invariant Verification

- **Method**: `GET`
- **Path**: `/admin/verify`
- **Response**:
  ```json
  {
    "invariants_passed": true,
    "checks": {
      "book_never_crossed": true,
      "single_location": true,
      "non_zero_quantity": true,
      "quantity_conservation": true,
      "volume_conservation": true,
      "gap_free_sequence": true
    },
    "current_seq": 1000,
    "canonical_hash": "<canonical_sha256_hex>"
  }
  ```

---

### 9. Health & System Metrics

- **`GET /health`**: Returns engine status, database connectivity, and sequencer queue depth.
- **`GET /metrics`**: Returns Prometheus-compatible / JSON operational metrics:
  - Total commands processed.
  - Group commit batch latency percentiles.
  - Active resting order count.
  - Memory consumption (heap used / total).

---

### 10. Real-Time Market Data Stream (Server-Sent Events)

- **Method**: `GET`
- **Path**: `/stream?symbol=BTC-USDT`
- **Headers**:
  - `Accept: text/event-stream`
- **Event Types**:
  - `depth`: Level 2 order book snapshot or delta update.
  - `trade`: Executed trade event.
  - `heartbeat`: Keepalive timestamp emitted every 15 seconds.
