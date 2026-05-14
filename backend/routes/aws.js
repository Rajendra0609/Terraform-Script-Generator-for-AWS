const router = require('express').Router();
const {
  EC2Client,
  DescribeImagesCommand,
  DescribeInstanceTypesCommand,
  DescribeAvailabilityZonesCommand,
} = require('@aws-sdk/client-ec2');

function makeClient(region) {
  return new EC2Client({ region: region || process.env.AWS_REGION || 'us-east-1' });
}

// GET /api/aws/instance-types?region=ap-south-1
router.get('/instance-types', async (req, res) => {
  const region = req.query.region || process.env.AWS_REGION || 'us-east-1';
  try {
    const client = makeClient(region);
    let types = [];
    let nextToken;
    do {
      const cmd = new DescribeInstanceTypesCommand({ MaxResults: 100, NextToken: nextToken });
      const out = await client.send(cmd);
      (out.InstanceTypes || []).forEach(t => { if (t.InstanceType) types.push(t.InstanceType); });
      nextToken = out.NextToken;
    } while (nextToken && types.length < 2000);

    const curated = [
      't2.micro','t2.small','t2.medium','t2.large',
      't3.nano','t3.micro','t3.small','t3.medium','t3.large','t3.xlarge',
      't3a.micro','t3a.small','t3a.medium',
      'm5.large','m5.xlarge','m5.2xlarge',
      'm6i.large','m6i.xlarge',
      'c5.large','c5.xlarge','c5.2xlarge',
      'c6i.large','c6i.xlarge',
      'r5.large','r5.xlarge',
      'r6i.large',
    ];
    const merged = Array.from(new Set([...types, ...curated])).sort();
    res.json({ region, count: merged.length, instance_types: merged });
  } catch (e) {
    res.status(500).json({ error: 'AWS request failed: ' + e.message });
  }
});

// GET /api/aws/availability-zones?region=ap-south-1
router.get('/availability-zones', async (req, res) => {
  const region = req.query.region || process.env.AWS_REGION || 'us-east-1';
  try {
    const client = makeClient(region);
    const out = await client.send(new DescribeAvailabilityZonesCommand({}));
    const zones = (out.AvailabilityZones || [])
      .filter(z => z.ZoneName && z.State === 'available')
      .map(z => z.ZoneName)
      .sort();
    res.json({ region, count: zones.length, zones });
  } catch (e) {
    res.status(500).json({ error: 'AWS request failed: ' + e.message });
  }
});

// GET /api/aws/amis?region=ap-south-1&q=amazon+linux&limit=12
router.get('/amis', async (req, res) => {
  const region = req.query.region || process.env.AWS_REGION || 'us-east-1';
  const q      = (req.query.q || '').trim();
  const limit  = Math.min(parseInt(req.query.limit || '12', 10), 50);

  // Static curated AMIs per region — always available even without AWS creds
  const CURATED = {
    'ap-south-1': [
      { id: 'ami-0f58b397bc5c1f2e8', name: 'Amazon Linux 2023 (ap-south-1)',      desc: 'Amazon Linux 2023 AMI',              owner: 'amazon' },
      { id: 'ami-0c768662cc797cd75', name: 'Amazon Linux 2 (ap-south-1)',          desc: 'Amazon Linux 2 LTS AMI',             owner: 'amazon' },
      { id: 'ami-0287a05f0ef0e9d9a', name: 'Ubuntu 22.04 LTS (ap-south-1)',        desc: 'Canonical Ubuntu Server 22.04',      owner: 'canonical' },
      { id: 'ami-0f5ee92e2d63afc18', name: 'Ubuntu 20.04 LTS (ap-south-1)',        desc: 'Canonical Ubuntu Server 20.04',      owner: 'canonical' },
      { id: 'ami-0d473344347176250', name: 'RHEL 9 (ap-south-1)',                  desc: 'Red Hat Enterprise Linux 9',         owner: 'redhat' },
      { id: 'ami-02b49a24cfb95941c', name: 'Windows Server 2022 (ap-south-1)',     desc: 'Microsoft Windows Server 2022',      owner: 'amazon' },
    ],
    'us-east-1': [
      { id: 'ami-0c02fb55956c7d316', name: 'Amazon Linux 2023 (us-east-1)',        desc: 'Amazon Linux 2023 AMI',              owner: 'amazon' },
      { id: 'ami-0cff7528ff583bf9a', name: 'Amazon Linux 2 (us-east-1)',           desc: 'Amazon Linux 2 LTS AMI',             owner: 'amazon' },
      { id: 'ami-0261755bbcb8c4a84', name: 'Ubuntu 22.04 LTS (us-east-1)',         desc: 'Canonical Ubuntu Server 22.04',      owner: 'canonical' },
      { id: 'ami-08d4ac5b634553e16', name: 'Ubuntu 20.04 LTS (us-east-1)',         desc: 'Canonical Ubuntu Server 20.04',      owner: 'canonical' },
      { id: 'ami-0b0dcb5067f052a63', name: 'Windows Server 2022 (us-east-1)',      desc: 'Microsoft Windows Server 2022',      owner: 'amazon' },
    ],
    'us-west-2': [
      { id: 'ami-094125af156557ca2', name: 'Amazon Linux 2023 (us-west-2)',        desc: 'Amazon Linux 2023 AMI',              owner: 'amazon' },
      { id: 'ami-0d70546e43a941d70', name: 'Ubuntu 22.04 LTS (us-west-2)',         desc: 'Canonical Ubuntu Server 22.04',      owner: 'canonical' },
    ],
    'eu-west-1': [
      { id: 'ami-04f7efe62f419d9f5', name: 'Amazon Linux 2023 (eu-west-1)',        desc: 'Amazon Linux 2023 AMI',              owner: 'amazon' },
      { id: 'ami-01dd271720c1ba44f', name: 'Ubuntu 22.04 LTS (eu-west-1)',         desc: 'Canonical Ubuntu Server 22.04',      owner: 'canonical' },
    ],
  };

  // Build fallback list for any region
  const defaultFallback = [
    { id: 'ami-0c55b159cbfafe1f0', name: 'Amazon Linux 2 (generic)',  desc: 'Amazon Linux 2 AMI — replace with region-specific ID', owner: 'amazon' },
    { id: 'ami-0dba2cb6798deb6d8', name: 'Ubuntu 20.04 LTS (generic)', desc: 'Canonical Ubuntu 20.04 — replace with region-specific ID', owner: 'canonical' },
  ];

  const curatedForRegion = CURATED[region] || defaultFallback;

  // If AWS creds are available, try a real lookup first
  try {
    const client = makeClient(region);

    // Build filters — always filter to available HVM images
    const filters = [
      { Name: 'state',            Values: ['available'] },
      { Name: 'virtualization-type', Values: ['hvm'] },
      { Name: 'architecture',     Values: ['x86_64'] },
    ];
    if (q) filters.push({ Name: 'name', Values: [`*${q}*`] });

    const owners = q ? ['amazon', '099720109477', '309956199498'] : ['amazon', '099720109477'];

    let out;
    try {
      out = await client.send(new DescribeImagesCommand({ Owners: owners, Filters: filters }));
    } catch (_) {
      // Credentials may be missing — fall through to curated list
    }

    if (out && out.Images && out.Images.length > 0) {
      const images = out.Images
        .filter(img => img.ImageId && img.Name)
        .sort((a, b) => new Date(b.CreationDate) - new Date(a.CreationDate))
        .slice(0, limit)
        .map(img => ({
          id:      img.ImageId,
          name:    img.Name || img.ImageId,
          desc:    img.Description || '',
          owner:   img.OwnerId,
          created: img.CreationDate,
        }));
      return res.json({ region, query: q, count: images.length, images, source: 'aws' });
    }
  } catch (_) {
    // AWS lookup failed — fall through to curated list
  }

  // Filter curated list by query string if provided
  let images = curatedForRegion;
  if (q) {
    const ql = q.toLowerCase();
    images = images.filter(img =>
      img.name.toLowerCase().includes(ql) ||
      img.desc.toLowerCase().includes(ql) ||
      img.id.toLowerCase().includes(ql)
    );
  }

  res.json({ region, query: q, count: images.length, images: images.slice(0, limit), source: 'curated' });
});

module.exports = router;
