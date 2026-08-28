import { useRef } from 'react';
import { motion, useInView } from 'motion/react';

const AnimatedItem = ({ children, delay = 0, index = 0, className = '' }: any) => {
  const ref = useRef(null);
  const inView = useInView(ref, { amount: 0.1, once: true });
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ scale: 0.8, opacity: 0, y: 20 }}
      animate={inView ? { scale: 1, opacity: 1, y: 0 } : { scale: 0.8, opacity: 0, y: 20 }}
      transition={{ duration: 0.4, delay: delay + (index % 4) * 0.1, type: "spring", stiffness: 100 }}
    >
      {children}
    </motion.div>
  );
};

export default AnimatedItem;
