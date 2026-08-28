const fs = require('fs');

let code = fs.readFileSync('src/pages/Product.tsx', 'utf8');

// I removed useCart accidentally while trying to fix lint errors for it before I realized it was imported. 
// However, the requested implementation of cart doesn't exist anymore without that context. I will restore useCart.

let orderCode = `
import { useCart } from '../lib/CartContext';

export default function Product() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [product, setProduct] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  const [quantity, setQuantity] = useState(1);
  const [selectedColor, setSelectedColor] = useState('');
  const [selectedSize, setSelectedSize] = useState('');
  const [orderType, setOrderType] = useState('pre_order');
  const dir = 'rtl';
  
  const [isAnimatingCart, setIsAnimatingCart] = useState(false);
  const { dispatch } = useCart();
`;

code = code.replace(/export default function Product\(\) \{[\s\S]*?const \[isAnimatingCart, setIsAnimatingCart\] = useState\(false\);/, orderCode.trim());


code = code.replace(/const handleAddToCart = \(\) => \{\s*\/\/ Add to cart placeholder for now\s*\};\s*if \(loading\)/s, 
`const handleAddToCart = () => {
    if (!product) return;
    dispatch({ 
      type: 'ADD_ITEM', 
      payload: {
        id: product.id,
        name: product.name,
        price: product.base_price,
        image: product.image_url || 'https://via.placeholder.com/300',
        quantity: quantity,
      }
    });
    setIsAnimatingCart(true);
    setTimeout(() => setIsAnimatingCart(false), 1000);
  };

  if (loading)`);

fs.writeFileSync('src/pages/Product.tsx', code);
