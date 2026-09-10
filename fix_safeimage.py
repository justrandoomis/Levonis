import re

with open('src/components/ui/SafeImage.tsx', 'r') as f:
    content = f.read()

# Add noRetry to destructured props
content = content.replace('  onStatus,\n}: {', '  onStatus,\n  noRetry = false,\n}: {')

# Add noRetry to TS type
content = content.replace('  onStatus?: (status: \'loading\' | \'loaded\' | \'error\', src: string) => void;\n}) {', '  onStatus?: (status: \'loading\' | \'loaded\' | \'error\', src: string) => void;\n  noRetry?: boolean;\n}) {')

with open('src/components/ui/SafeImage.tsx', 'w') as f:
    f.write(content)
