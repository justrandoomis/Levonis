export interface Product {
  id: string;
  name: string;
  price: number;
  originalPrice?: number;
  proPrice?: number;
  image: string;
  category: string;
  stock: number;
  description?: string;
  options?: string[];
  colors?: string[];
  features?: string[];
  availability?: 'pre_order' | 'in_stock';
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'customer';
}

export interface MainSection {
  id: string;
  titleKey: string;
}

export interface SubSection {
  id: string;
  mainSectionId: string;
  titleKey: string;
  subtitleKey?: string;
  iconText?: string;
  image?: string;
}
