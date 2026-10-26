
const companyPrefixes = ['Acme','Northwind','Globex','Initech','Umbrella','Stark','Wayne','Wonka','Hooli','Pied Piper','Soylent','Vandelay','Dunder','Cyberdyne','Tyrell','Massive Dynamic','Aperture','Black Mesa','Gringotts','Ollivander','Blue','Silver','Redwood','Summit','Harbor','Atlas','Nimbus','Orbit','Lumen','Vertex','Cedar','Iron','Golden','Pioneer','Crescent','Evergreen'];
const companySuffixes = ['Health','Retail','Bank','Labs','Systems','Media','Logistics','Energy','Foods','Robotics','Software','Cloud','Analytics','Manufacturing','Group','Partners','Holdings','Network','Digital','Works'];
const firstNames = ['Ava','Liam','Noah','Mia','Ethan','Sophia','Lucas','Isabella','Mason','Amelia','James','Harper','Ben','Elena','Chen','Wei','Yuki','Priya','Omar','Sofia','Diego','Nina','Kai','Zara'];
const lastNames = ['Chen','Wang','Li','Zhang','Smith','Johnson','Brown','Garcia','Miller','Davis','Wilson','Anderson','Taylor','Thomas','Moore','Martin','Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Lewis'];
const industries = ['SaaS','Finance','Healthcare','Retail','Manufacturing','Education','Logistics','Energy'];
const regions = ['APAC','APAC','EMEA','EMEA','AMER','AMER','AMER'];
const tiers = ['Strategic','Enterprise','Enterprise','Mid-Market','Mid-Market','SMB','SMB'];
const customerStatuses = ['Active','Active','Active','Active','Trial','Trial','Prospect','Prospect','Churned'];
const orderStatuses = ['Draft','Pending','Pending','Paid','Paid','Paid','Fulfilled','Fulfilled','Cancelled','Refunded'];
const channels = ['Web','Web','Sales','Sales','Partner','Marketplace'];
const currencies = ['USD','USD','USD','EUR','CNY','GBP'];
const roles = ['Champion','Decision Maker','Admin','User','User'];
const categories = ['SaaS','Hardware','Services','Support','Add-on'];
const productPrefixes = ['Starter','Growth','Enterprise','Pro','Lite','Secure','Smart','Cloud','Edge','Data'];
const productSuffixes = ['Suite','Plan','License','Appliance','Support','Connector','Add-on','Package','Service','Module'];
const noteTemplates = ['Renewal discussion scheduled next month.','Procurement requires a security review before expansion.','Expansion opportunity in the APAC team.','Customer asked for SSO and audit log coverage.','Pilot converted to annual contract.','Budget approval pending for next quarter.','Champion changed role; re-engage the new owner.','Support volume dropped after onboarding.','客户希望增加中文界面和导出功能。','需求集中在权限矩阵与审计日志。','Emoji-heavy notes: 🚀 priority, ⚠️ renewal risk.'];

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

export default function createProfile(options, h) {
  const products = h.count('products', 200, { scaled: true });
  const customers = h.count('customers', 2000, { scaled: true });
  const contactsPerCustomer = h.count('contacts-per-customer', 2, { min: 0 });
  const ordersPerCustomer = h.count('orders-per-customer', 8);
  const itemsPerOrder = h.count('items-per-order', 3);
  const contacts = customers * contactsPerCustomer;
  const orders = customers * ordersPerCustomer;
  const orderItems = orders * itemsPerOrder;

  function productPlan(index) {
    const rng = h.rng(index, 1);
    const category = categories[index % categories.length];
    const base = category === 'Hardware' ? 1200 : category === 'Services' ? 8000 : category === 'Support' ? 3000 : 120;
    const price = h.money(base * (0.5 + rng() * 2));
    return { Name: `${productPrefixes[index % productPrefixes.length]} ${productSuffixes[Math.floor(index / productPrefixes.length) % productSuffixes.length]}`, SKU: `SKU-${String(index + 1).padStart(6, '0')}`, Category: category, UnitPrice: price, Cost: h.money(price * 0.45), Active: rng() > 0.1, Notes: h.note(rng) };
  }

  function customerPlan(index) {
    const rng = h.rng(index, 2);
    const name = `${companyPrefixes[index % companyPrefixes.length]} ${companySuffixes[Math.floor(index / companyPrefixes.length) % companySuffixes.length]}${index >= companyPrefixes.length * companySuffixes.length ? ` ${index}` : ''}`;
    const domain = `${slug(name).split('-')[0] || 'customer'}${index}.example`;
    return { Name: name, Industry: h.pick(rng, industries), Region: h.pick(rng, regions), Tier: h.pick(rng, tiers), Status: h.pick(rng, customerStatuses), ARR: h.money(rng() < 0.2 ? 500000 + rng() * 2000000 : 10000 + rng() * 500000), Owner: `${h.pick(rng, firstNames)} ${h.pick(rng, lastNames)}`, Email: `hello@${domain}`, Phone: `+1-${200 + Math.floor(rng() * 700)}-555-${String(1000 + Math.floor(rng() * 8999))}`, Website: `https://www.${domain}`, CreatedDate: h.date(-Math.floor(rng() * 365)), Notes: rng() < 0.05 ? '' : h.note(rng), HealthScore: 1 + Math.floor(rng() * 5) };
  }

  function contactPlan(index) {
    const rng = h.rng(index, 3);
    const customerIndex = Math.floor(index / contactsPerCustomer);
    const name = `${h.pick(rng, firstNames)} ${h.pick(rng, lastNames)}`;
    return { Name: name, Email: `${slug(name).replace(/-/g, '.')}@customer${customerIndex}.example`, Phone: `+1-${200 + Math.floor(rng() * 700)}-555-${String(1000 + Math.floor(rng() * 8999))}`, Role: h.pick(rng, roles), OptIn: rng() > 0.25, LastTouch: h.date(-Math.floor(rng() * 365)), Customer: null, Notes: rng() < 0.1 ? '' : h.note(rng) };
  }

  function orderPlan(index) {
    const rng = h.rng(index, 4);
    const hot = rng() < 0.6;
    const customerIndex = Math.floor((hot ? rng() * customers * 0.2 : rng() * customers));
    const lines = [];
    let subtotal = 0;
    for (let line = 0; line < itemsPerOrder; line++) {
      const hotProduct = rng() < 0.6;
      const productIndex = Math.floor(hotProduct ? rng() * products * 0.2 : rng() * products);
      const product = productPlan(productIndex);
      const quantity = 1 + Math.floor(rng() * 10);
      const discount = rng() < 0.7 ? 0 : h.money(quantity * product.UnitPrice * rng() * 0.2);
      subtotal += quantity * product.UnitPrice - discount;
      lines.push({ productIndex, quantity, unitPrice: product.UnitPrice, discount });
    }
    const orderDate = h.date(-Math.floor(rng() * 365));
    const dueDate = new Date(Date.parse(orderDate) + (14 + Math.floor(rng() * 47)) * 86400000).toISOString();
    return { OrderNo: `SO-2026-${String(index + 1).padStart(7, '0')}`, Customer: null, customerIndex, Status: h.pick(rng, orderStatuses), Channel: h.pick(rng, channels), Currency: h.pick(rng, currencies), OrderDate: orderDate, DueDate: dueDate, Subtotal: h.money(subtotal), Discount: h.money(subtotal * (rng() < 0.6 ? 0 : rng() * 0.05)), Owner: `${h.pick(rng, firstNames)} ${h.pick(rng, lastNames)}`, Notes: rng() < 0.15 ? '' : h.note(rng), lines };
  }

  return {
    domain: 'crm',
    description: 'CRM: products, customers, contacts, orders, and order lines',
    primary: 'customers',
    distribution: '60% of draws from top 20% customers/products; weighted statuses; 5–15% empty notes; last-365-day dates; USD/EUR/CNY/GBP',
    workloads: [
      { table: 'customers', field: 'Notes', description: 'Update a customer note' },
      { table: 'orders', field: 'Notes', description: 'Update an order note' },
      { table: 'orderItems', field: 'Notes', description: 'Update an order line note' },
    ],
    tables: [
      { key: 'products', name: 'Products', count: products, fields: [h.text('Name'), h.text('SKU'), h.select('Category', categories), h.number('UnitPrice'), h.number('Cost'), h.checkbox('Active'), { name: 'Notes', type: 'longText' }], record: (index) => productPlan(index) },
      { key: 'customers', name: 'Customers', count: customers, fields: [h.text('Name'), h.select('Industry', industries), h.select('Region', ['APAC', 'EMEA', 'AMER']), h.select('Tier', ['Strategic', 'Enterprise', 'Mid-Market', 'SMB']), h.select('Status', ['Active', 'Trial', 'Prospect', 'Churned']), h.number('ARR'), h.text('Owner'), h.text('Email'), h.text('Phone'), h.text('Website'), h.dateField('CreatedDate'), { name: 'Notes', type: 'longText' }, { name: 'HealthScore', type: 'rating', options: { icon: 'star', color: 'yellowBright', max: 5 } }], record: (index) => customerPlan(index) },
      { key: 'contacts', name: 'Contacts', count: contacts, fields: [h.text('Name'), h.text('Email'), h.text('Phone'), h.select('Role', ['Champion', 'Decision Maker', 'Admin', 'User']), h.checkbox('OptIn'), h.dateField('LastTouch'), h.linkField('Customer', 'customers'), { name: 'Notes', type: 'longText' }], record: (index, ctx) => { const plan = contactPlan(index); plan.Customer = ctx.link('customers', Math.floor(index / contactsPerCustomer)); return plan; } },
      { key: 'orders', name: 'Orders', count: orders, fields: [h.text('OrderNo'), h.linkField('Customer', 'customers'), h.select('Status', ['Draft', 'Pending', 'Paid', 'Fulfilled', 'Cancelled', 'Refunded']), h.select('Channel', ['Web', 'Sales', 'Partner', 'Marketplace']), h.select('Currency', ['USD', 'EUR', 'CNY', 'GBP']), h.dateField('OrderDate'), h.dateField('DueDate'), h.number('Subtotal'), h.number('Discount'), h.text('Owner'), { name: 'Notes', type: 'longText' }, h.formula('NetTotal', '{Subtotal} - {Discount}')], record: (index, ctx) => { const plan = orderPlan(index); plan.Customer = ctx.link('customers', plan.customerIndex); delete plan.customerIndex; delete plan.lines; return plan; } },
      { key: 'orderItems', name: 'OrderItems', count: orderItems, fields: [h.text('LineNo'), h.linkField('Order', 'orders'), h.linkField('Product', 'products'), h.number('Quantity'), h.number('UnitPrice'), h.number('Discount'), { name: 'Notes', type: 'longText' }, h.formula('LineTotal', '{Quantity} * {UnitPrice} - {Discount}')], record: (index, ctx) => { const orderIndex = Math.floor(index / itemsPerOrder); const plan = orderPlan(orderIndex); const line = plan.lines[index % itemsPerOrder]; return { LineNo: `LI-${String(index + 1).padStart(7, '0')}`, Order: ctx.link('orders', orderIndex), Product: ctx.link('products', line.productIndex), Quantity: line.quantity, UnitPrice: line.unitPrice, Discount: line.discount, Notes: line.quantity > 5 ? 'Bulk order' : '' }; } },
    ],
  };
}
