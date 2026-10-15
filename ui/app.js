document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const participantKeyInput = document.getElementById('participant-key');
  const adminKeyInput = document.getElementById('admin-key');
  const sseIndicator = document.getElementById('sse-indicator');
  const sseStatus = document.getElementById('sse-status');
  const headerSeq = document.getElementById('header-seq');
  const headerHash = document.getElementById('header-hash');

  const orderForm = document.getElementById('order-form');
  const orderSymbol = document.getElementById('order-symbol');
  const btnBuy = document.getElementById('btn-side-buy');
  const btnSell = document.getElementById('btn-side-sell');
  const orderType = document.getElementById('order-type');
  const orderPrice = document.getElementById('order-price');
  const orderQty = document.getElementById('order-qty');
  const orderFeedback = document.getElementById('order-feedback');

  const cancelForm = document.getElementById('cancel-form');
  const cancelOrderId = document.getElementById('cancel-order-id');
  const cancelFeedback = document.getElementById('cancel-feedback');

  const btnVerifyReplay = document.getElementById('btn-verify-replay');
  const btnCheckInvariants = document.getElementById('btn-check-invariants');
  const auditResult = document.getElementById('audit-result');

  const ladderAsks = document.getElementById('ladder-asks');
  const ladderBids = document.getElementById('ladder-bids');
  const spreadValue = document.getElementById('spread-value');
  const midValue = document.getElementById('mid-value');
  const tapeRows = document.getElementById('tape-rows');
  const eventStream = document.getElementById('event-stream');

  let activeSide = 'BUY';
  let sseSource = null;

  // Side Toggle Handler
  btnBuy.addEventListener('click', () => {
    activeSide = 'BUY';
    btnBuy.classList.add('active');
    btnSell.classList.remove('active');
  });

  btnSell.addEventListener('click', () => {
    activeSide = 'SELL';
    btnSell.classList.add('active');
    btnBuy.classList.remove('active');
  });

  // Order Type Handler
  orderType.addEventListener('change', () => {
    const isMarket = orderType.value === 'MARKET';
    orderPrice.disabled = isMarket;
    if (isMarket) {
      orderPrice.placeholder = 'Market order (no limit)';
    } else {
      orderPrice.placeholder = 'Price in ticks';
    }
  });

  // Append Event Log Entry
  function logEvent(text, category = 'system') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${category}`;
    const time = new Date().toLocaleTimeString();
    entry.textContent = `[${time}] ${text}`;
    eventStream.appendChild(entry);
    eventStream.scrollTop = eventStream.scrollHeight;
  }

  // Connect Server-Sent Events (SSE)
  function initSSE() {
    if (sseSource) {
      sseSource.close();
    }

    sseSource = new EventSource('/events');

    sseSource.onopen = () => {
      sseIndicator.className = 'indicator connected';
      sseStatus.textContent = 'Live SSE';
      logEvent('Connected to real-time event stream.', 'system');
    };

    sseSource.onmessage = e => {
      try {
        const data = JSON.parse(e.data);
        if (data.seq) {
          headerSeq.textContent = data.seq;
        }

        if (data.event === 'TRADE_EXECUTED') {
          addTapeRow(data);
          logEvent(
            `TRADE #${data.trade_id}: ${data.quantity} @ ${data.price} (${data.taker_side})`,
            'trade'
          );
        } else if (data.event) {
          logEvent(`EVENT #${data.seq}: ${data.event} (order ${data.order_id || '-'})`, 'order');
        }

        // Refresh book depth and system health
        fetchDepth();
      } catch {
        // Ping or non-json message
      }
    };

    sseSource.onerror = () => {
      sseIndicator.className = 'indicator disconnected';
      sseStatus.textContent = 'Disconnected';
      logEvent('SSE connection dropped. Retrying...', 'system');
    };
  }

  // Add Row to Trade Tape
  function addTapeRow(trade) {
    if (tapeRows.querySelector('.empty-state')) {
      tapeRows.innerHTML = '';
    }

    const row = document.createElement('div');
    const isBuy = trade.taker_side === 'BUY';
    row.className = `tape-row ${isBuy ? 'buy' : 'sell'}`;

    const timeStr = trade.seq ? `#${trade.seq}` : new Date().toLocaleTimeString();
    row.innerHTML = `
      <span>${timeStr}</span>
      <span class="side">${trade.taker_side}</span>
      <span>${Number(trade.price).toLocaleString()}</span>
      <span>${Number(trade.quantity).toLocaleString()}</span>
    `;

    tapeRows.insertBefore(row, tapeRows.firstChild);
    while (tapeRows.children.length > 50) {
      tapeRows.removeChild(tapeRows.lastChild);
    }
  }

  // Fetch and Render Order Book Depth Ladder
  async function fetchDepth() {
    const symbol = orderSymbol.value;
    try {
      const res = await fetch(`/depth?symbol=${encodeURIComponent(symbol)}&depth=15`);
      if (!res.ok) return;
      const data = await res.json();
      renderLadder(data);
    } catch {
      // Offline / network failure
    }
  }

  function renderLadder(data) {
    const bids = data.bids || [];
    const asks = data.asks || [];

    // Calculate maximum volume across bids and asks for proportional depth bars
    let maxVol = 1;
    bids.forEach(b => (maxVol = Math.max(maxVol, b.quantity)));
    asks.forEach(a => (maxVol = Math.max(maxVol, a.quantity)));

    // Asks Ladder: displayed in descending order from highest down to lowest ask
    if (asks.length === 0) {
      ladderAsks.innerHTML = '<div class="empty-state">No resting asks</div>';
    } else {
      const sortedAsks = [...asks].sort((a, b) => b.price - a.price);
      ladderAsks.innerHTML = sortedAsks
        .map(a => {
          const pct = Math.min(100, Math.round((a.quantity / maxVol) * 100));
          return `
          <div class="ladder-row ask" data-price="${a.price}">
            <div class="depth-bar" style="width: ${pct}%"></div>
            <span class="price mono">${a.price}</span>
            <span class="size mono">${a.quantity.toLocaleString()}</span>
            <span class="orders mono">${a.order_count}</span>
            <span></span>
          </div>
        `;
        })
        .join('');
    }

    // Spread Row
    const bestBid = bids.length > 0 ? bids[0].price : null;
    const bestAsk = asks.length > 0 ? asks[0].price : null;

    if (bestBid !== null && bestAsk !== null) {
      const spread = bestAsk - bestBid;
      const mid = ((bestAsk + bestBid) / 2).toFixed(1);
      spreadValue.textContent = `${spread} ticks`;
      midValue.textContent = mid;
    } else {
      spreadValue.textContent = '-';
      midValue.textContent = '-';
    }

    // Bids Ladder: displayed descending from best bid down to lowest
    if (bids.length === 0) {
      ladderBids.innerHTML = '<div class="empty-state">No resting bids</div>';
    } else {
      ladderBids.innerHTML = bids
        .map(b => {
          const pct = Math.min(100, Math.round((b.quantity / maxVol) * 100));
          return `
          <div class="ladder-row bid" data-price="${b.price}">
            <div class="depth-bar" style="width: ${pct}%"></div>
            <span class="price mono">${b.price}</span>
            <span class="size mono">${b.quantity.toLocaleString()}</span>
            <span class="orders mono">${b.order_count}</span>
            <span></span>
          </div>
        `;
        })
        .join('');
    }

    // Add click-to-populate price handler on ladder rows
    document.querySelectorAll('.ladder-row').forEach(row => {
      row.addEventListener('click', () => {
        const price = row.getAttribute('data-price');
        if (price) {
          orderPrice.value = price;
        }
      });
    });
  }

  // Update System Health & Hash
  async function fetchHealth() {
    try {
      const res = await fetch('/health');
      if (res.ok) {
        const data = await res.json();
        if (data.seq !== undefined) {
          headerSeq.textContent = data.seq;
        }
      }
    } catch {
      // Offline
    }
  }

  // Submit Order Handler
  orderForm.addEventListener('submit', async e => {
    e.preventDefault();
    orderFeedback.className = 'form-feedback';
    orderFeedback.textContent = 'Submitting command...';

    const apiKey = participantKeyInput.value.trim();
    if (!apiKey) {
      orderFeedback.className = 'form-feedback error';
      orderFeedback.textContent = 'Error: Enter participant key first.';
      return;
    }

    const payload = {
      symbol: orderSymbol.value,
      side: activeSide,
      type: orderType.value,
      quantity: Number(orderQty.value),
      client_order_id: `ui-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    };

    if (payload.type !== 'MARKET') {
      payload.price = Number(orderPrice.value);
    }

    try {
      const res = await fetch('/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify(payload),
      });

      const body = await res.json();
      if (res.ok) {
        orderFeedback.className = 'form-feedback success';
        orderFeedback.textContent = `Order accepted: ID #${body.order_id || '-'} (seq #${body.seq})`;
        fetchDepth();
      } else {
        orderFeedback.className = 'form-feedback error';
        orderFeedback.textContent = `Rejected [${body.error || body.code || res.status}]: ${body.message || JSON.stringify(body)}`;
      }
    } catch (err) {
      orderFeedback.className = 'form-feedback error';
      orderFeedback.textContent = `Network error: ${err.message}`;
    }
  });

  // Cancel Order Handler
  cancelForm.addEventListener('submit', async e => {
    e.preventDefault();
    cancelFeedback.className = 'form-feedback';
    cancelFeedback.textContent = 'Submitting cancel...';

    const apiKey = participantKeyInput.value.trim();
    if (!apiKey) {
      cancelFeedback.className = 'form-feedback error';
      cancelFeedback.textContent = 'Error: Enter participant key first.';
      return;
    }

    const orderId = Number(cancelOrderId.value);

    try {
      const res = await fetch(`/orders/${orderId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          client_order_id: `ui-cancel-${Date.now()}`,
        }),
      });

      const body = await res.json();
      if (res.ok) {
        cancelFeedback.className = 'form-feedback success';
        cancelFeedback.textContent = `Order #${orderId} cancelled (seq #${body.seq})`;
        fetchDepth();
      } else {
        cancelFeedback.className = 'form-feedback error';
        cancelFeedback.textContent = `Cancel rejected: ${body.error || body.code || res.status}`;
      }
    } catch (err) {
      cancelFeedback.className = 'form-feedback error';
      cancelFeedback.textContent = `Network error: ${err.message}`;
    }
  });

  // Verify Replay Handler (Admin Endpoint)
  btnVerifyReplay.addEventListener('click', async () => {
    auditResult.textContent = 'Executing deterministic replay against naive oracle...';
    const adminKey = adminKeyInput.value.trim();

    try {
      const res = await fetch('/admin/replay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': adminKey,
        },
        body: JSON.stringify({ oracle: true }),
      });

      const body = await res.json();
      if (res.ok && body.verified) {
        auditResult.style.color = '#10b981';
        auditResult.textContent = `STATUS: VERIFIED\nReplayed: ${body.commands_replayed} commands\nOracle parity: MATCHED\nState Hash: ${body.state_hash.slice(0, 16)}...\nDuration: ${body.duration_ms} ms`;
        headerHash.textContent = body.state_hash.slice(0, 8);
        headerHash.title = body.state_hash;
      } else {
        auditResult.style.color = '#ef4444';
        auditResult.textContent = `STATUS: ${body.status || 'FAILED'}\nError: ${body.error || 'Divergence detected'}\nDivergence: ${JSON.stringify(body.divergence || {})}`;
      }
    } catch (err) {
      auditResult.style.color = '#ef4444';
      auditResult.textContent = `Admin request error: ${err.message}`;
    }
  });

  // Check Invariants Handler (Admin Endpoint)
  btnCheckInvariants.addEventListener('click', async () => {
    auditResult.textContent = 'Auditing database and engine invariants...';
    const adminKey = adminKeyInput.value.trim();

    try {
      const res = await fetch('/admin/verify', {
        headers: {
          'X-Admin-Key': adminKey,
        },
      });

      const body = await res.json();
      if (res.ok && body.invariants_passed) {
        auditResult.style.color = '#10b981';
        auditResult.textContent = `INVARIANTS PASSED\nSeq: ${body.current_seq}\nHash: ${body.canonical_hash.slice(0, 16)}...\nDatabase checks:\n- gap_free: ${body.checks?.gap_free_sequence}\n- zero_volume: ${body.checks?.zero_volume_pruned}\n- db_sync: ${body.checks?.orders_table_in_sync}`;
        headerHash.textContent = body.canonical_hash.slice(0, 8);
        headerHash.title = body.canonical_hash;
      } else {
        auditResult.style.color = '#ef4444';
        auditResult.textContent = `INVARIANTS FAILED\n${body.error || JSON.stringify(body)}`;
      }
    } catch (err) {
      auditResult.style.color = '#ef4444';
      auditResult.textContent = `Verification error: ${err.message}`;
    }
  });

  // Initialize
  initSSE();
  fetchHealth();
  fetchDepth();
  setInterval(fetchDepth, 2000);
});
