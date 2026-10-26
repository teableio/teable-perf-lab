// E-commerce profile: catalog, customers, orders, order lines, per-warehouse
// inventory, and returns. Every row is derived from (seed, index, salt); no
// wall clock and no network calls. Formulas are declared but never populated
// here because Teable computes them.

const CATEGORIES = [
  'Electronics',
  'Home',
  'Apparel',
  'Grocery',
  'Beauty',
  'Sports',
  'Books',
  'Toys',
];

const CATEGORY_BASE_PRICE = {
  Electronics: 1299,
  Home: 399,
  Apparel: 199,
  Grocery: 39,
  Beauty: 129,
  Sports: 599,
  Books: 59,
  Toys: 99,
};

const PRODUCT_BRANDS = [
  'Aurora',
  'Nimbus',
  'Cedar',
  'Lumen',
  'Vertex',
  'Harbor',
  'Pioneer',
  'Evergreen',
  'Atlas',
  'Orbit',
];

const PRODUCT_FAMILIES = [
  'Wireless Earbuds',
  'Desk Lamp',
  'Cotton Shirt',
  'Green Tea',
  'Face Cream',
  'Yoga Mat',
  'Notebook Set',
  'Building Blocks',
  'Travel Mug',
  'Backpack',
  'Bluetooth Speaker',
  'Throw Blanket',
  'Running Shoes',
  'Olive Oil',
  'Hand Soap',
  'Water Bottle',
  'Cookbook',
  'Puzzle Cube',
  'Phone Stand',
  'Storage Basket',
  'Fitness Tracker',
  'Linen Towel',
  'Trail Jacket',
  'Nut Mix',
];

const PRODUCT_TAGS = ['New', 'Bestseller', 'Clearance', 'Bulk', 'Eco', 'Imported'];

const COMPANY_PREFIXES = [
  'Acme',
  'Northwind',
  'Globex',
  'Initech',
  'Umbrella',
  'Stark',
  'Wayne',
  'Wonka',
  'Hooli',
  'Pied Piper',
  'Soylent',
  'Vandelay',
  'Dunder',
  'Cyberdyne',
  'Tyrell',
  'Massive Dynamic',
  'Aperture',
  'Black Mesa',
  'Gringotts',
  'Ollivander',
  'Blue',
  'Silver',
  'Redwood',
  'Summit',
  'Harbor',
  'Atlas',
  'Nimbus',
  'Orbit',
  'Lumen',
  'Vertex',
  'Cedar',
  'Iron',
  'Golden',
  'Pioneer',
  'Crescent',
  'Evergreen',
];

const COMPANY_SUFFIXES = [
  'Health',
  'Retail',
  'Bank',
  'Labs',
  'Systems',
  'Media',
  'Logistics',
  'Energy',
  'Foods',
  'Robotics',
  'Software',
  'Cloud',
  'Analytics',
  'Manufacturing',
  'Group',
  'Partners',
  'Holdings',
  'Network',
  'Digital',
  'Works',
];

const CUSTOMER_TIERS = ['Gold', 'Silver', 'Bronze'];
const CUSTOMER_REGIONS = ['North', 'East', 'South', 'West', 'Central'];
const CUSTOMER_STATUSES = ['Active', 'Prospect', 'Inactive', 'Churned'];
const CUSTOMER_SEGMENTS = [
  'VIP',
  'Wholesale',
  'Repeat Buyer',
  'New',
  'At-Risk',
  'Newsletter',
];

const ORDER_STATUSES = [
  'Pending',
  'Paid',
  'Processing',
  'Shipped',
  'Delivered',
  'Cancelled',
  'Refunded',
];
const ORDER_CHANNELS = ['Web', 'Mobile', 'Marketplace', 'Retail', 'Partner'];
const ORDER_PRIORITIES = ['Standard', 'Standard', 'High', 'Rush'];
const ORDER_TAGS = ['Gift', 'Express', 'Wholesale', 'Promo', 'Subscription'];
const PAYMENT_METHODS = ['Alipay', 'WeChat Pay', 'Card', 'Bank Transfer'];
const SALES_OWNERS = [
  'Ava Chen',
  'Liam Wang',
  'Noah Li',
  'Mia Zhang',
  'Ethan Wu',
  'Sophia Liu',
  'Lucas Zhao',
  'Isabella Sun',
];

const RETURN_REASONS = [
  'Damaged',
  'Wrong item',
  'Not as described',
  'Late delivery',
  'Changed mind',
  'Quality issue',
];
const RETURN_STATUSES = ['Requested', 'Approved', 'Rejected', 'Refunded', 'Closed'];

// Date anchor used by the shared helper is 2026-10-01 UTC. Orders live in the
// 2025-06 .. 2026-06 window so due, delivery, and return dates stay in the past.
const ORDER_DAY_MIN = -480;
const ORDER_DAY_SPAN = 361;

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

export default function createProfile(options, helpers) {
  const h = helpers;

  const products = h.count('products', 200, { min: 1, scaled: true });
  const customers = h.count('customers', 2000, { min: 1, scaled: true });
  const ordersPerCustomer = h.count('orders-per-customer', 8, { min: 1 });
  const itemsPerOrder = h.count('items-per-order', 3, { min: 1 });
  const warehouses = h.count('warehouses', 3, { min: 1 });
  const returnEvery = h.count('return-every', 10, { min: 1 });

  const orders = customers * ordersPerCustomer;
  const orderItems = orders * itemsPerOrder;
  const inventory = products * warehouses;

  // Exactly ceil(20%) of each table is the "hot" block. A reference draw is:
  // 60% uniform inside the hot block, 40% uniform over the full table. The
  // resulting hot-block share is 0.6 + 0.4 * hot / total, not a promise that
  // 80% of rows receive 20% of traffic.
  const hotProducts = Math.max(1, Math.ceil(products * 0.2));
  const hotCustomers = Math.max(1, Math.ceil(customers * 0.2));
  const productHotShare = 60 + (40 * hotProducts) / products;
  const customerHotShare = 60 + (40 * hotCustomers) / customers;

  function productCategory(index) {
    return CATEGORIES[index % CATEGORIES.length];
  }

  function productPricing(index) {
    const random = h.rng(index, 1001);
    const category = productCategory(index);
    const base = CATEGORY_BASE_PRICE[category] || 100;
    const unitPrice = h.money(base * (0.6 + random() * 2.2));
    const cost = h.money(unitPrice * (0.45 + random() * 0.2));
    return { unitPrice, cost };
  }

  function productName(index) {
    const family = PRODUCT_FAMILIES[index % PRODUCT_FAMILIES.length];
    const brand =
      PRODUCT_BRANDS[Math.floor(index / PRODUCT_FAMILIES.length) % PRODUCT_BRANDS.length];
    return `${brand} ${family} ${String(index + 1).padStart(4, '0')}`;
  }

  function productDescription(index) {
    const random = h.rng(index, 1002);
    const category = productCategory(index);
    const family = PRODUCT_FAMILIES[index % PRODUCT_FAMILIES.length];
    const intro = h.pick(random, [
      `Everyday ${category.toLowerCase()} essential built for repeat use.`,
      `Compact ${category.toLowerCase()} item designed for small homes and shared desks.`,
      `Durable ${category.toLowerCase()} product with a clean, practical finish.`,
      `Seasonal ${category.toLowerCase()} favorite with straightforward care instructions.`,
    ]);
    const detail = h.pick(random, [
      'Ships in recyclable packaging; no assembly required.',
      'Batch-tested and packed by the regional fulfillment team.',
      'Available in standard and wholesale case sizes.',
      'Backed by a 12-month replacement policy.',
      'Sized for retail shelves and e-commerce parcel handling.',
    ]);
    return `${family}. ${intro} ${detail}`;
  }

  function companyName(index) {
    const prefix = COMPANY_PREFIXES[index % COMPANY_PREFIXES.length];
    const suffix =
      COMPANY_SUFFIXES[Math.floor(index / COMPANY_PREFIXES.length) % COMPANY_SUFFIXES.length];
    const collisions = COMPANY_PREFIXES.length * COMPANY_SUFFIXES.length;
    return index >= collisions ? `${prefix} ${suffix} ${index + 1}` : `${prefix} ${suffix}`;
  }

  function customerRecord(index) {
    const random = h.rng(index, 1011);
    const name = companyName(index);
    const domain = `${slug(name).split('-')[0] || 'customer'}${index + 1}.example`;
    return {
      Name: name,
      Tier: h.pick(random, CUSTOMER_TIERS),
      Region: h.pick(random, CUSTOMER_REGIONS),
      Status: h.pick(random, CUSTOMER_STATUSES),
      Segments: pickTags(h, index, CUSTOMER_SEGMENTS, 1012),
      Email: `buyer${String(index + 1).padStart(6, '0')}@${domain}`,
      Phone: `+86-${100 + Math.floor(random() * 900)}-555-${String(1000 + Math.floor(random() * 9000))}`,
      Website: `https://${domain}`,
      LTV: h.money(500 + random() * 49500),
      VIP: random() < 0.18,
      CreatedDate: h.date(-900 + ((index * 29 + 7) % 720)),
      Notes: h.note(h.rng(index, 1013)),
    };
  }

  function customerIndexForOrder(orderIndex) {
    const random = h.rng(orderIndex, 1021);
    const hot = random() < 0.6;
    const draw = hot
      ? Math.floor(random() * hotCustomers)
      : Math.floor(random() * customers);
    return Math.min(customers - 1, Math.max(0, draw));
  }

  function orderStatus(index) {
    // Keep order 0 delivered so a one-order smoke dataset still has a valid
    // return candidate; the remaining statuses follow fixed thresholds so the
    // same seed always yields the same mix.
    if (index === 0) return 'Delivered';
    const random = h.rng(index, 1022);
    const roll = random();
    if (roll < 0.34) return 'Delivered';
    if (roll < 0.55) return 'Shipped';
    if (roll < 0.7) return 'Paid';
    if (roll < 0.82) return 'Processing';
    if (roll < 0.91) return 'Pending';
    if (roll < 0.97) return 'Cancelled';
    return 'Refunded';
  }

  function orderDay(index) {
    return ORDER_DAY_MIN + ((index * 37 + 11) % ORDER_DAY_SPAN);
  }

  function productIndexForItem(itemIndex) {
    const random = h.rng(itemIndex, 1023);
    const hot = random() < 0.6;
    const draw = hot
      ? Math.floor(random() * hotProducts)
      : Math.floor(random() * products);
    return Math.min(products - 1, Math.max(0, draw));
  }

  function orderLine(orderIndex, lineIndex) {
    const itemIndex = orderIndex * itemsPerOrder + lineIndex;
    const productIndex = productIndexForItem(itemIndex);
    const pricing = productPricing(productIndex);
    const quantityRandom = h.rng(itemIndex, 1024);
    const quantity = 1 + Math.floor(quantityRandom() * 8);
    const discountRandom = h.rng(itemIndex, 1025);
    const gross = quantity * pricing.unitPrice;
    const rawDiscount =
      discountRandom() < 0.68
        ? 0
        : h.money(gross * (0.02 + discountRandom() * 0.18));
    // Keep a line above zero after cent rounding so the formula is a valid sum.
    const discount = Math.min(rawDiscount, h.money(Math.max(0, gross - 0.01)));
    return {
      productIndex,
      quantity,
      unitPrice: pricing.unitPrice,
      discount,
      lineTotal: h.money(gross - discount),
    };
  }

  function orderPlan(orderIndex) {
    const lines = [];
    let subtotal = 0;
    for (let lineIndex = 0; lineIndex < itemsPerOrder; lineIndex++) {
      const line = orderLine(orderIndex, lineIndex);
      subtotal += line.lineTotal;
      lines.push(line);
    }
    const random = h.rng(orderIndex, 1026);
    const orderDiscount =
      random() < 0.7 ? 0 : h.money(subtotal * (0.01 + random() * 0.04));
    const discount = Math.min(orderDiscount, h.money(Math.max(0, subtotal - 0.01)));
    return {
      customerIndex: customerIndexForOrder(orderIndex),
      status: orderStatus(orderIndex),
      orderDay: orderDay(orderIndex),
      lines,
      subtotal: h.money(subtotal),
      discount,
    };
  }

  // Eligible item rows are exactly the lines of delivered orders. We only
  // keep delivered order indices (O(orders)); individual item rows are still
  // derived arithmetically, so the full item table is never materialized.
  const deliveredOrders = [];
  for (let orderIndex = 0; orderIndex < orders; orderIndex++) {
    if (orderStatus(orderIndex) === 'Delivered') deliveredOrders.push(orderIndex);
  }
  const eligibleItemRows = deliveredOrders.length * itemsPerOrder;
  const returns = Math.floor(eligibleItemRows / returnEvery);

  function returnTarget(index) {
    const eligibleOffset = index * returnEvery;
    const orderOrdinal = Math.floor(eligibleOffset / itemsPerOrder);
    const lineIndex = eligibleOffset % itemsPerOrder;
    const orderIndex = deliveredOrders[orderOrdinal];
    return {
      orderIndex,
      lineIndex,
      itemIndex: orderIndex * itemsPerOrder + lineIndex,
    };
  }

  function pickTags(helper, index, values, salt) {
    const random = helper.rng(index, salt);
    const first = helper.pick(random, values);
    if (random() >= 0.35) return [first];
    const second = helper.pick(random, values);
    return second === first ? [first] : [first, second];
  }

  return {
    domain: 'ecommerce',
    description:
      'Six-table e-commerce dataset: catalog, customers, orders, order lines, per-warehouse inventory, and returns for delivered lines. All amounts are CNY, order subtotals are sums of their line totals, and every row is deterministic for a given seed.',
    primary: 'orders',
    distribution:
      `Order -> Customer and OrderItem -> Product references use two draws each: 60% pick uniformly from the first ceil(20%) block ` +
      `(${hotCustomers}/${customers} customers and ${hotProducts}/${products} products); the other 40% pick uniformly from the full table. ` +
      `Net hot-block share at this size is ${customerHotShare.toFixed(2)}% of customer links and ${productHotShare.toFixed(2)}% of product links; ` +
      `the remaining ${(100 - customerHotShare).toFixed(2)}% and ${(100 - productHotShare).toFixed(2)}% land on the rest of each table. ` +
      `Inventory covers every product in every warehouse.`,
    workloads: [
      {
        table: 'orders',
        field: 'Notes',
        description: 'Update order notes while an operator reviews exceptions.',
      },
      {
        table: 'customers',
        field: 'Notes',
        description: 'Update customer notes after a support or account call.',
      },
      {
        table: 'products',
        field: 'Description',
        description: 'Refresh product copy without touching SKU, price, or links.',
      },
    ],
    tables: [
      {
        key: 'products',
        name: 'Products',
        count: products,
        fields: [
          h.text('Name'),
          h.text('SKU'),
          h.select('Category', CATEGORIES),
          h.number('UnitPrice'),
          h.number('Cost'),
          h.checkbox('Active'),
          h.multiSelect('Tags', PRODUCT_TAGS),
          h.text('Supplier'),
          h.dateField('CreatedDate'),
          { name: 'Description', type: 'longText' },
        ],
        record(index) {
          const random = h.rng(index, 1003);
          const pricing = productPricing(index);
          return {
            Name: productName(index),
            SKU: `SKU-${String(index + 1).padStart(7, '0')}`,
            Category: productCategory(index),
            UnitPrice: pricing.unitPrice,
            Cost: pricing.cost,
            Active: random() > 0.08,
            Tags: pickTags(h, index, PRODUCT_TAGS, 1004),
            Supplier: `SUP-${String((index % 24) + 1).padStart(2, '0')}`,
            CreatedDate: h.date(-980 + ((index * 19 + 3) % 730)),
            Description: productDescription(index),
          };
        },
      },
      {
        key: 'customers',
        name: 'Customers',
        count: customers,
        fields: [
          h.text('Name'),
          h.select('Tier', CUSTOMER_TIERS),
          h.select('Region', CUSTOMER_REGIONS),
          h.select('Status', CUSTOMER_STATUSES),
          h.multiSelect('Segments', CUSTOMER_SEGMENTS),
          h.text('Email'),
          h.text('Phone'),
          h.text('Website'),
          h.number('LTV'),
          h.checkbox('VIP'),
          h.dateField('CreatedDate'),
          { name: 'Notes', type: 'longText' },
        ],
        record: customerRecord,
      },
      {
        key: 'orders',
        name: 'Orders',
        count: orders,
        fields: [
          h.text('OrderNo'),
          h.linkField('Customer', 'customers'),
          h.select('Status', ORDER_STATUSES),
          h.select('Channel', ORDER_CHANNELS),
          h.select('Currency', ['CNY', 'USD', 'EUR']),
          h.dateField('OrderDate'),
          h.dateField('DueDate'),
          h.number('Subtotal'),
          h.number('Discount'),
          h.select('PaymentMethod', PAYMENT_METHODS),
          h.select('Priority', ORDER_PRIORITIES),
          h.multiSelect('Tags', ORDER_TAGS),
          h.text('Owner'),
          { name: 'Notes', type: 'longText' },
          h.formula('NetTotal', '{Subtotal} - {Discount}'),
        ],
        record(index, ctx) {
          const plan = orderPlan(index);
          const random = h.rng(index, 1027);
          return {
            OrderNo: `SO-2026-${String(index + 1).padStart(7, '0')}`,
            Customer: ctx.link('customers', plan.customerIndex),
            Status: plan.status,
            Channel: h.pick(random, ORDER_CHANNELS),
            Currency: 'CNY',
            OrderDate: h.date(plan.orderDay),
            DueDate: h.date(plan.orderDay + 7 + ((index * 13) % 30)),
            Subtotal: plan.subtotal,
            Discount: plan.discount,
            PaymentMethod: h.pick(random, PAYMENT_METHODS),
            Priority: h.pick(random, ORDER_PRIORITIES),
            Tags: pickTags(h, index, ORDER_TAGS, 1028),
            Owner: h.pick(random, SALES_OWNERS),
            Notes: h.note(h.rng(index, 1029)),
          };
        },
      },
      {
        key: 'orderItems',
        name: 'OrderItems',
        count: orderItems,
        fields: [
          h.text('LineNo'),
          h.linkField('Order', 'orders'),
          h.linkField('Product', 'products'),
          h.number('Quantity'),
          h.number('UnitPrice'),
          h.number('Discount'),
          h.select('Fulfillment', ORDER_STATUSES),
          { name: 'Notes', type: 'longText' },
          h.formula('LineTotal', '{Quantity} * {UnitPrice} - {Discount}'),
        ],
        record(index, ctx) {
          const orderIndex = Math.floor(index / itemsPerOrder);
          const lineIndex = index % itemsPerOrder;
          const line = orderLine(orderIndex, lineIndex);
          const notesRandom = h.rng(index, 1031);
          return {
            LineNo: `LI-${String(index + 1).padStart(8, '0')}`,
            Order: ctx.link('orders', orderIndex),
            Product: ctx.link('products', line.productIndex),
            Quantity: line.quantity,
            UnitPrice: line.unitPrice,
            Discount: line.discount,
            Fulfillment: orderStatus(orderIndex),
            Notes: line.quantity > 5 ? 'Bulk line; confirm parcel split.' : h.note(notesRandom),
          };
        },
      },
      {
        key: 'inventory',
        name: 'Inventory',
        count: inventory,
        fields: [
          h.text('InventoryNo'),
          h.linkField('Product', 'products'),
          h.text('Warehouse'),
          h.number('OnHand'),
          h.number('Reserved'),
          h.number('ReorderPoint'),
          h.number('UnitCost'),
          h.formula('ReorderQty', 'MAX({ReorderPoint} - {OnHand}, 0)'),
          h.dateField('LastCounted'),
          h.checkbox('CycleCount'),
          { name: 'Notes', type: 'longText' },
        ],
        record(index, ctx) {
          const productIndex = Math.floor(index / warehouses);
          const warehouseIndex = index % warehouses;
          const random = h.rng(index, 1032);
          const onHand = Math.floor(random() * 900);
          const reserved = Math.floor(random() * Math.min(onHand, 180) + (onHand > 0 ? 1 : 0));
          const reorderPoint = 20 + Math.floor(random() * 180);
          const pricing = productPricing(productIndex);
          return {
            InventoryNo: `INV-${String(productIndex + 1).padStart(6, '0')}-${String(
              warehouseIndex + 1
            ).padStart(3, '0')}`,
            Product: ctx.link('products', productIndex),
            Warehouse: `WH-${String(warehouseIndex + 1).padStart(2, '0')}`,
            OnHand: onHand,
            Reserved: Math.min(onHand, reserved),
            ReorderPoint: reorderPoint,
            UnitCost: pricing.cost,
            LastCounted: h.date(-90 + ((index * 7 + 3) % 90)),
            CycleCount: random() > 0.7,
            Notes: h.note(h.rng(index, 1033)),
          };
        },
      },
      {
        key: 'returns',
        name: 'Returns',
        count: returns,
        fields: [
          h.text('ReturnNo'),
          h.linkField('OrderItem', 'orderItems'),
          h.linkField('Order', 'orders'),
          h.linkField('Customer', 'customers'),
          h.select('Reason', RETURN_REASONS),
          h.select('Status', RETURN_STATUSES),
          h.number('Quantity'),
          h.number('RefundAmount'),
          h.dateField('RequestedDate'),
          h.dateField('ResolvedDate'),
          h.checkbox('Restock'),
          { name: 'Notes', type: 'longText' },
        ],
        record(index, ctx) {
          const target = returnTarget(index);
          const plan = orderPlan(target.orderIndex);
          const line = plan.lines[target.lineIndex];
          const random = h.rng(index, 1034);
          const quantity = 1 + Math.floor(random() * line.quantity);
          const requestDay = plan.orderDay + 10 + Math.floor(random() * 30);
          const resolveDay = Math.min(
            -1,
            requestDay + 1 + Math.floor(random() * 25)
          );
          const statusRoll = random();
          const status =
            statusRoll < 0.55
              ? 'Refunded'
              : statusRoll < 0.75
                ? 'Approved'
                : statusRoll < 0.9
                  ? 'Requested'
                  : 'Rejected';
          const boundedRefund = Math.min(
            line.lineTotal,
            h.money(quantity * line.unitPrice * (0.4 + random() * 0.6))
          );
          const refundable = status === 'Refunded' || status === 'Approved';
          return {
            ReturnNo: `RMA-2026-${String(index + 1).padStart(6, '0')}`,
            OrderItem: ctx.link('orderItems', target.itemIndex),
            Order: ctx.link('orders', target.orderIndex),
            Customer: ctx.link('customers', plan.customerIndex),
            Reason: h.pick(random, RETURN_REASONS),
            Status: status,
            Quantity: quantity,
            RefundAmount: refundable ? boundedRefund : 0,
            RequestedDate: h.date(requestDay),
            ResolvedDate: h.date(resolveDay),
            Restock: random() > 0.35,
            Notes: h.note(h.rng(index, 1035)),
          };
        },
      },
    ],
  };
}
