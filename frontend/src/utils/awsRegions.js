export const AWS_REGIONS = {
  'us-east-1': '🇺🇸 N. Virginia',
  'us-east-2': '🇺🇸 Ohio',
  'us-west-1': '🇺🇸 N. California',
  'us-west-2': '🇺🇸 Oregon',
  'ca-central-1': '🇨🇦 Canada (Central)',
  'sa-east-1': '🇧🇷 São Paulo',
  'eu-west-1': '🇮🇪 Ireland',
  'eu-west-2': '🇬🇧 London',
  'eu-west-3': '🇫🇷 Paris',
  'eu-central-1': '🇩🇪 Frankfurt',
  'eu-north-1': '🇸🇪 Stockholm',
  'eu-south-1': '🇮🇹 Milan',
  'ap-south-1': '🇮🇳 Mumbai',
  'ap-southeast-1': '🇸🇬 Singapore',
  'ap-southeast-2': '🇦🇺 Sydney',
  'ap-northeast-1': '🇯🇵 Tokyo',
  'ap-northeast-2': '🇰🇷 Seoul',
  'ap-northeast-3': '🇯🇵 Osaka',
  'ap-east-1': '🇭🇰 Hong Kong',
  'me-south-1': '🇦🇪 Bahrain',
  'af-south-1': '🇿🇦 Cape Town',
  'eu-central-2': '🇵🇱 Warsaw',
  'me-central-1': '🇶🇦 Doha',
  'il-central-1': '🇮🇱 Tel Aviv',
  'af-north-1': '🇲🇦 Morocco',
  'eu-north-2': '🇫🇮 Helsinki',
  'ap-south-2': '🇮🇩 Jakarta',
};

export const getAwsRegionLabel = (region) => {
  if (!region) return 'Unknown region';
  return AWS_REGIONS[region] || region;
};
