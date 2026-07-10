{
  networking.hostName = "uriel-box";

  nix.settings = {
    experimental-features = [
      "nix-command"
      "flakes"
    ];
    # Keep direnv dev shells alive across garbage collection.
    keep-outputs = true;
    keep-derivations = true;
  };
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 14d";
  };
  nix.optimise.automatic = true;

  # devices matches disko.devices.disk.main.device. efiSupport plus
  # efiInstallAsRemovable installs GRUB for both the BIOS and EFI boot paths,
  # so the same config boots Hetzner cloud images and dedicated servers.
  boot.loader.grub = {
    enable = true;
    devices = [ "/dev/sda" ];
    efiSupport = true;
    efiInstallAsRemovable = true;
  };

  # Needed by nixos-anywhere and kept as a tailnet-only fallback; the firewall
  # never opens port 22 on the public interface.
  services.openssh = {
    enable = true;
    openFirewall = false;
    settings.PasswordAuthentication = false;
  };
  users.users.root.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAA... replace-me"
  ];

  services.tailscale = {
    enable = true;
    extraUpFlags = [ "--ssh" ];
    authKeyFile = "/run/secrets/tailscale-authkey";
  };

  # Nothing listens on the public interface; SSH and the worker API are
  # reachable over the tailnet only.
  networking.firewall = {
    enable = true;
    trustedInterfaces = [ "tailscale0" ];
    allowedTCPPorts = [ ];
  };

  services.uriel-worker = {
    enable = true;
    # Binds all interfaces; the firewall trusting only tailscale0 is what
    # keeps the API tailnet-only.
    host = "0.0.0.0";
    allowedRepos = [ "acme/app" ];
    maxConcurrentJobs = 1;
    artifactRetentionDays = 14;
    environmentFiles = [ "/run/secrets/uriel-worker.env" ];
    extraEnvironment = {
      URIEL_ADAPTER_REPO_BOOTSTRAP = "direnv";
      URIEL_ADAPTER_HARNESS = "claude-code";
    };
    # Hetzner Cloud VPS expose no KVM (nested virtualization is unsupported on
    # all cloud tiers); set true only on a dedicated/auction bare-metal server
    # where /dev/kvm exists.
    enableAndroidQa = false;
  };

  system.stateVersion = "25.05";
}
