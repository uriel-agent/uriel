{
  description = "Hetzner + Tailscale host running the Uriel worker";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    uriel.url = "github:uriel-agent/uriel";
  };

  outputs =
    {
      nixpkgs,
      disko,
      uriel,
      ...
    }:
    {
      nixosConfigurations.uriel-box = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [
          disko.nixosModules.disko
          uriel.nixosModules.uriel-worker
          ./disko.nix
          ./configuration.nix
          # Written on first deploy by nixos-anywhere with
          # --generate-hardware-config nixos-generate-config ./hardware-configuration.nix
          ./hardware-configuration.nix
        ];
      };
    };
}
