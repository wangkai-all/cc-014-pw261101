export interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
  desc: string;
}

export const PRODUCTS: Product[] = [
  { id: 'SKU-1001', name: '降噪头戴耳机 Pro', price: 899, category: '音频', desc: '主动降噪，40 小时续航' },
  { id: 'SKU-1002', name: '机械键盘 87 键', price: 359, category: '外设', desc: '热插拔红轴，三模连接' },
  { id: 'SKU-1003', name: '4K 显示器 27 寸', price: 1799, category: '显示', desc: 'IPS，HDR400，Type-C 90W' },
  { id: 'SKU-1004', name: '人体工学椅', price: 1299, category: '家具', desc: '腰背分区，4D 扶手' },
  { id: 'SKU-1005', name: '便携固态硬盘 1TB', price: 549, category: '存储', desc: '读取 2000MB/s，金属外壳' },
  { id: 'SKU-1006', name: '智能台灯', price: 199, category: '家居', desc: '无频闪，色温可调' },
];
